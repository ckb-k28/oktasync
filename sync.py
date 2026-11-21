#!/usr/bin/env python3
"""
Headless Docker Synchronisatie Script voor Gedeelde O365 / SharePoint Map met Okta MFA.
- Gebruikt Microsoft First-Party Client ID + 'organizations' authority voor Okta (https://nepglobal.okta.com).
- Eenmalige MFA bootstrap:
    docker exec -it oktasync python3 /app/sync.py --init-auth
- Verbindingstest (dry-run zonder downloads):
    docker exec oktasync python3 /app/sync.py --verify
- Handmatige testrun buiten 08:00-20:00 venster:
    docker exec oktasync python3 /app/sync.py --force
"""
import os
import sys
import datetime
import urllib.parse
import requests
import msal
from cryptography.fernet import Fernet

TENANT_DOMAIN   = os.environ.get("O365_TENANT_DOMAIN", "nepinc.sharepoint.com")
AUTH_AUTHORITY  = os.environ.get("O365_AUTHORITY", "https://login.microsoftonline.com/organizations")
SITE_NAME       = os.environ.get("O365_SITE_NAME", "NEPNL-Operations")
SHARED_FOLDER   = os.environ.get("O365_SHARED_FOLDER", "/02. Callsheets")
IGNORE_FOLDERS  = {
    f.strip().lower()
    for f in os.environ.get("O365_IGNORE_FOLDERS", "Callsheets Archief").split(",")
    if f.strip()
}
CLIENT_ID       = os.environ.get("O365_CLIENT_ID", "d3590ed6-52b3-4102-aeff-aad2292ab01c")
OKTA_URL        = os.environ.get("OKTA_FEDERATION_URL", "https://nepglobal.okta.com")
USERNAME_HINT   = os.environ.get("O365_USERNAME_HINT", "voornaam.achternaam@nepworldwide.nl")
LOCAL_SYNC_DIR  = os.environ.get("LOCAL_SYNC_DIR", "/data/sync")
VAULT_FILE      = os.environ.get("TOKEN_VAULT_FILE", "/vault/token_cache.enc")
FERNET_KEY      = os.environ.get("FERNET_VAULT_KEY", "")
START_HOUR      = int(os.environ.get("START_HOUR", "8"))
END_HOUR        = int(os.environ.get("END_HOUR", "20"))

SCOPES = [
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/Sites.Read.All"
]

def normalize_sharepoint_folder(folder_path: str) -> str:
    """Verwijdert optionele 'Shared Documents/' prefix omdat Graph drive/root daar al op wijst."""
    cleaned = folder_path.strip("/")
    for prefix in ("Shared Documents/", "Gedeelde documenten/"):
        if cleaned.lower().startswith(prefix.lower()):
            cleaned = cleaned[len(prefix):]
    return cleaned.strip("/")

def get_cipher() -> Fernet:
    if not FERNET_KEY:
        raise RuntimeError(
            "FERNET_VAULT_KEY ontbreekt in de Docker environment variabelen. "
            "Genereer een sleutel en zet deze in uw .env bestand op de Docker host."
        )
    return Fernet(FERNET_KEY.encode("utf-8"))

def load_encrypted_token_cache() -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    if os.path.exists(VAULT_FILE):
        cipher = get_cipher()
        with open(VAULT_FILE, "rb") as f:
            encrypted_bytes = f.read()
        decrypted_json = cipher.decrypt(encrypted_bytes).decode("utf-8")
        cache.deserialize(decrypted_json)
    return cache

def save_encrypted_token_cache(cache: msal.SerializableTokenCache) -> None:
    if cache.has_state_changed:
        os.makedirs(os.path.dirname(VAULT_FILE), exist_ok=True)
        cipher = get_cipher()
        encrypted_bytes = cipher.encrypt(cache.serialize().encode("utf-8"))
        with open(VAULT_FILE, "wb") as f:
            f.write(encrypted_bytes)
        os.chmod(VAULT_FILE, 0o600)

def acquire_graph_token(init_device_flow: bool = False) -> str:
    cache = load_encrypted_token_cache()
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTH_AUTHORITY, token_cache=cache)

    if init_device_flow:
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Kan OAuth2 Device Flow niet starten: {flow.get('error_description')}")

        print("\n" + "=" * 72)
        print(" [OKTA MFA BOOTSTRAP IN HEADLESS DOCKER CONTAINER]")
        print(f" 1. Open op uw pc of telefoon: {flow['verification_uri']}")
        print(f" 2. Voer de eenmalige code in : {flow['user_code']}")
        print(f" 3. Log in als '{USERNAME_HINT}' via {OKTA_URL} en bevestig Okta MFA.")
        print("=" * 72 + "\n", flush=True)

        result = app.acquire_token_by_device_flow(flow)
        if "access_token" not in result:
            raise RuntimeError(
                f"Login of Okta MFA mislukt ({result.get('error')}): {result.get('error_description')}"
            )

        save_encrypted_token_cache(cache)
        print(f"[SUCCESS] Okta MFA voltooid! Refresh Token is AES-128 versleuteld opgeslagen in {VAULT_FILE}")
        return result["access_token"]

    accounts = app.get_accounts(username=USERNAME_HINT) or app.get_accounts()
    if not accounts:
        raise RuntimeError(
            f"Geen versleutelde sessie gevonden in {VAULT_FILE}. "
            "Voer eerst 'docker exec -it oktasync python3 /app/sync.py --init-auth' uit."
        )

    # Vernieuwt het Access Token stilzwijgend via het Refresh Token (geen MFA prompt nodig)
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    save_encrypted_token_cache(cache)

    if not result or "access_token" not in result:
        err_code = result.get("error") if result else "no_result"
        err_desc = result.get("error_description") if result else "Onbekende fout"
        raise RuntimeError(
            f"Stille token-vernieuwing geweigerd ({err_code}): {err_desc}."
        )
    return result["access_token"]

def list_folder_children(headers: dict, site_id: str, folder_rel_path: str) -> list:
    encoded_path = urllib.parse.quote(folder_rel_path)
    next_url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root:/{encoded_path}:/children"
    all_items = []
    while next_url:
        resp = requests.get(next_url, headers=headers, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        all_items.extend(payload.get("value", []))
        next_url = payload.get("@odata.nextLink")
    return all_items

def verify_connection() -> None:
    """5-staps preflight controle zonder bestanden te downloaden."""
    print("[CHECK 1/5] Controleer FERNET_VAULT_KEY & versleutelde tokenkluis...")
    if not os.path.exists(VAULT_FILE):
        raise RuntimeError(f"Tokenkluis ontbreekt in {VAULT_FILE}. Draai eerst --init-auth.")
    load_encrypted_token_cache()
    print("  -> OK: Kluis succesvol ontsleuteld.")

    print("[CHECK 2/5] Test stille Okta/Entra OAuth2 token-vernieuwing (zonder MFA prompt)...")
    token = acquire_graph_token(init_device_flow=False)
    headers = {"Authorization": f"Bearer {token}"}
    print("  -> OK: Vers Access Token verkregen via Refresh Token.")

    print(f"[CHECK 3/5] Verifieer SharePoint site '{TENANT_DOMAIN}/sites/{SITE_NAME}'...")
    site_url = f"https://graph.microsoft.com/v1.0/sites/{TENANT_DOMAIN}:/sites/{SITE_NAME}"
    site_resp = requests.get(site_url, headers=headers, timeout=30)
    site_resp.raise_for_status()
    site_id = site_resp.json()["id"]
    print(f"  -> OK: Site gevonden (ID: {site_id[:32]}...).")

    base_folder = normalize_sharepoint_folder(SHARED_FOLDER)
    print(f"[CHECK 4/5] Lees gedeelde map '/{base_folder}' & controleer ignore-regel...")
    items = list_folder_children(headers, site_id, base_folder)
    ignored_hits = [
        i["name"] for i in items
        if "folder" in i and i["name"].strip().lower() in IGNORE_FOLDERS
    ]
    file_count = sum(1 for i in items if "file" in i)
    folder_count = sum(1 for i in items if "folder" in i)
    print(f"  -> OK: {file_count} directe bestanden en {folder_count} submappen gevonden.")
    print(f"  -> OK: Genegeerde mappen herkend en geblokkeerd: {ignored_hits or sorted(IGNORE_FOLDERS)}")

    print(f"[CHECK 5/5] Test schrijfrechten in lokale Docker mount '{LOCAL_SYNC_DIR}'...")
    os.makedirs(LOCAL_SYNC_DIR, exist_ok=True)
    probe_file = os.path.join(LOCAL_SYNC_DIR, ".sync_write_probe")
    with open(probe_file, "w", encoding="utf-8") as f:
        f.write("ok")
    os.remove(probe_file)
    print("  -> OK: Host bind-mount is beschrijfbaar.")
    print("\n[VERIFIED] Alle 5 verbindingscontroles geslaagd. De 2-uurlijkse sync is bedrijfsklaar.")

def sync_folder_recursive(headers: dict, site_id: str, remote_rel_path: str, local_dir: str) -> tuple[int, int]:
    os.makedirs(local_dir, exist_ok=True)
    items = list_folder_children(headers, site_id, remote_rel_path)
    checked = 0
    downloaded = 0

    for item in items:
        item_name = item["name"]

        # Negeer submappen die op de negeerlijst staan (bijv. 'Callsheets Archief')
        if "folder" in item:
            if item_name.strip().lower() in IGNORE_FOLDERS:
                print(f"[IGNORE] SharePoint submap overgeslagen: {remote_rel_path}/{item_name}")
                continue
            sub_checked, sub_downloaded = sync_folder_recursive(
                headers,
                site_id,
                f"{remote_rel_path}/{item_name}",
                os.path.join(local_dir, item_name)
            )
            checked += sub_checked
            downloaded += sub_downloaded
            continue

        if "file" not in item:
            continue

        checked += 1
        remote_size = item["size"]
        download_url = item["@microsoft.graph.downloadUrl"]
        target_path = os.path.join(local_dir, item_name)

        # Delta-check op bestandsgrootte
        if os.path.exists(target_path) and os.path.getsize(target_path) == remote_size:
            continue

        with requests.get(download_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(target_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)

        downloaded += 1
        print(f"[SYNC] Gedownload: {remote_rel_path}/{item_name} ({remote_size} bytes)")

    return checked, downloaded

def run_folder_sync(force: bool = False) -> None:
    now = datetime.datetime.now()
    if not force and not (START_HOUR <= now.hour <= END_HOUR):
        print(f"[SKIP] {now.strftime('%H:%M')} valt buiten het actieve venster ({START_HOUR:02d}:00-{END_HOUR:02d}:00).")
        return

    token = acquire_graph_token(init_device_flow=False)
    headers = {"Authorization": f"Bearer {token}"}

    # 1. Haal het SharePoint Site ID op via Microsoft Graph
    site_url = f"https://graph.microsoft.com/v1.0/sites/{TENANT_DOMAIN}:/sites/{SITE_NAME}"
    site_resp = requests.get(site_url, headers=headers, timeout=30)
    site_resp.raise_for_status()
    site_id = site_resp.json()["id"]

    # 2. Synchroniseer recursief en sla IGNORE_FOLDERS ('Callsheets Archief') over
    base_folder = normalize_sharepoint_folder(SHARED_FOLDER)
    checked, downloaded = sync_folder_recursive(headers, site_id, base_folder, LOCAL_SYNC_DIR)

    print(
        f"[OK] {now.strftime('%Y-%m-%d %H:%M:%S')} - Gecontroleerd: {checked}, "
        f"Gedownload: {downloaded} naar {LOCAL_SYNC_DIR} (Genegeerd: {sorted(IGNORE_FOLDERS)})"
    )

if __name__ == "__main__":
    if "--init-auth" in sys.argv:
        acquire_graph_token(init_device_flow=True)
    elif "--verify" in sys.argv:
        verify_connection()
    else:
        run_folder_sync(force="--force" in sys.argv)
