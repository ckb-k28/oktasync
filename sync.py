#!/usr/bin/env python3
"""
Docker Synchronisatie Script voor Gedeelde O365 / SharePoint Map met Okta MFA.

Ondersteunde methodes (automatische detectie op basis van opgeslagen kluis):
1. [AANBEVOLEN - Zero Entra App / Immuun voor AADSTS65001 & AADSTS65002]
   Directe SharePoint REST API met Okta Browser Sessie-Vault (FedAuth + rtFa):
     docker exec -it oktasync python3 /app/sync.py --init-cookies

2. [Alternatief via Microsoft Graph Command Line Tools (14d82eec-...)]
   OAuth2 Device Code Flow + Fernet Vault:
     docker exec -it oktasync python3 /app/sync.py --init-auth

Verbindingstest zonder downloads:
  docker exec oktasync python3 /app/sync.py --verify

Handmatige testrun buiten 08:00-20:00 venster:
  docker exec oktasync python3 /app/sync.py --force
"""
import datetime
import getpass
import json
import os
import sys
import urllib.parse
import msal
import requests
from cryptography.fernet import Fernet

def get_app_version() -> str:
    env_ver = os.environ.get("APP_VERSION", "").strip()
    if env_ver:
        return env_ver
    if os.path.isfile("/app/VERSION"):
        try:
            with open("/app/VERSION", "r", encoding="utf-8") as vf:
                return vf.read().strip() or "v.01"
        except OSError:
            pass
    return "v.01"


APP_VERSION     = get_app_version()
TENANT_DOMAIN   = os.environ.get("O365_TENANT_DOMAIN", "nepinc.sharepoint.com")
AUTH_AUTHORITY  = os.environ.get("O365_AUTHORITY", "https://login.microsoftonline.com/organizations")
SITE_NAME       = os.environ.get("O365_SITE_NAME", "NEPNL-Operations")
SHARED_FOLDER   = os.environ.get("O365_SHARED_FOLDER", "/02. Callsheets")
IGNORE_FOLDERS  = {
    f.strip().lower()
    for f in os.environ.get("O365_IGNORE_FOLDERS", "Callsheets Archief").split(",")
    if f.strip()
}
# 14d82eec-... = Microsoft Graph Command Line Tools (vervangt d3590ed6-... dat AADSTS65002 gaf)
CLIENT_ID       = os.environ.get("O365_CLIENT_ID", "14d82eec-204b-4c2f-b7e8-296a70dab67e")
OKTA_URL        = os.environ.get("OKTA_FEDERATION_URL", "https://nepglobal.okta.com")
USERNAME_HINT   = os.environ.get("O365_USERNAME_HINT", "voornaam.achternaam@nepworldwide.nl")
LOCAL_SYNC_DIR  = os.environ.get("LOCAL_SYNC_DIR", "/data/sync")
VAULT_FILE      = os.environ.get("TOKEN_VAULT_FILE", "/vault/token_cache.enc")
COOKIE_VAULT    = os.environ.get("COOKIE_VAULT_FILE", "/vault/sp_cookies.enc")
FERNET_KEY      = os.environ.get("FERNET_VAULT_KEY", "")
START_HOUR      = int(os.environ.get("START_HOUR", "8"))
END_HOUR        = int(os.environ.get("END_HOUR", "20"))
SYNC_LOG_FILE   = os.environ.get("SYNC_LOG_FILE", "/tmp/oktasync.log")

SCOPES = [
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/Sites.Read.All",
]


def log(message: str) -> None:
    """Schrijf elke stap direct met tijdstempel naar stdout én naar het gedeelde logbestand."""
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = message.splitlines() or [""]
    formatted = "\n".join(f"[{ts}] {line}" if line else "" for line in lines)
    print(formatted, flush=True)
    try:
        log_dir = os.path.dirname(SYNC_LOG_FILE)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with open(SYNC_LOG_FILE, "a", encoding="utf-8") as lf:
            lf.write(formatted + "\n")
    except OSError:
        pass


def normalize_sharepoint_folder(folder_path: str) -> str:
    """Verwijdert optionele 'Shared Documents/' prefix."""
    cleaned = folder_path.strip("/")
    for prefix in ("Shared Documents/", "Gedeelde documenten/"):
        if cleaned.lower().startswith(prefix.lower()):
            cleaned = cleaned[len(prefix):]
    return cleaned.strip("/")


def get_server_relative_base() -> str:
    return f"/sites/{SITE_NAME}/Shared Documents/{normalize_sharepoint_folder(SHARED_FOLDER)}"


def get_cipher() -> Fernet:
    if not FERNET_KEY:
        raise RuntimeError(
            "FERNET_VAULT_KEY ontbreekt in de Docker environment variabelen. "
            "Genereer een sleutel en zet deze in uw .env bestand op de Docker host."
        )
    return Fernet(FERNET_KEY.encode("utf-8"))


# ==============================================================================
# MODE 1 (AANBEVOLEN): Directe SharePoint REST API + Cookie Vault (FedAuth/rtFa)
# ==============================================================================
def init_cookie_vault() -> None:
    print("\n" + "=" * 72)
    print(" [SHAREPOINT + OKTA SESSIE-VAULT (ZERO ENTRA APP / GEEN AADSTS65001/65002)]")
    print(f" 1. Open in uw browser: https://{TENANT_DOMAIN}/sites/{SITE_NAME}")
    print(f" 2. Log in met Username + Password + Okta MFA ({OKTA_URL}).")
    print(f" 3. Open DevTools (F12) -> Application -> Cookies -> https://{TENANT_DOMAIN}")
    print(" 4. Kopieer de waarden van 'FedAuth' en 'rtFa' (invoer wordt verborgen).")
    print("=" * 72 + "\n", flush=True)

    fed_auth = getpass.getpass("FedAuth cookie waarde: ").strip()
    rt_fa = getpass.getpass("rtFa cookie waarde   : ").strip()
    if not fed_auth or not rt_fa:
        raise RuntimeError("Zowel FedAuth als rtFa zijn verplicht.")

    os.makedirs(os.path.dirname(COOKIE_VAULT), exist_ok=True)
    payload = json.dumps({"FedAuth": fed_auth, "rtFa": rt_fa}).encode("utf-8")
    encrypted = get_cipher().encrypt(payload)
    try:
        with open(COOKIE_VAULT, "wb") as f:
            f.write(encrypted)
        os.chmod(COOKIE_VAULT, 0o600)
    except PermissionError as exc:
        raise RuntimeError(
            f"Geen schrijfrechten op {COOKIE_VAULT}. "
            "Voer op de Docker host uit: chown -R 1000:1000 /opt/docker/callsheets/data /opt/docker/callsheets/vault "
            "of update naar de nieuwste Docker image (docker compose pull && docker compose up -d)."
        ) from exc
    print(f"[SUCCESS] Okta/SharePoint cookies AES-128 versleuteld opgeslagen in {COOKIE_VAULT}")


def build_sp_session() -> requests.Session:
    if not os.path.exists(COOKIE_VAULT):
        raise RuntimeError(
            f"Geen cookie-kluis gevonden in {COOKIE_VAULT}. "
            "Voer eerst 'docker exec -it oktasync python3 /app/sync.py --init-cookies' uit."
        )
    with open(COOKIE_VAULT, "rb") as f:
        data = json.loads(get_cipher().decrypt(f.read()).decode("utf-8"))

    session = requests.Session()
    session.cookies.set("FedAuth", data["FedAuth"], domain=TENANT_DOMAIN)
    session.cookies.set("rtFa", data["rtFa"], domain=TENANT_DOMAIN)
    session.headers.update({"Accept": "application/json;odata=nometadata"})
    return session


def encode_odata_path(path_value: str) -> str:
    escaped = path_value.replace("'", "''")
    return urllib.parse.quote(escaped, safe="/")


def sp_get_folder_items(session: requests.Session, server_rel_path: str) -> tuple[list, list]:
    encoded = encode_odata_path(server_rel_path)
    base_api = (
        f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/"
        f"GetFolderByServerRelativePath(decodedurl='{encoded}')"
    )
    folders_resp = session.get(f"{base_api}/Folders", timeout=30)
    if folders_resp.status_code in (401, 403):
        raise RuntimeError(
            "SharePoint sessie verlopen of ongeldig (HTTP 401/403). "
            "Vernieuw uw cookies via: docker exec -it oktasync python3 /app/sync.py --init-cookies"
        )
    folders_resp.raise_for_status()

    files_resp = session.get(f"{base_api}/Files", timeout=30)
    files_resp.raise_for_status()
    return folders_resp.json().get("value", []), files_resp.json().get("value", [])


def verify_cookie_connection() -> None:
    log("[VERIFY] Verbindingstest gestart (Cookie Vault modus)")
    log(f"[CHECK 1/4] Ontsleutel SharePoint cookie-kluis ({COOKIE_VAULT})...")
    session = build_sp_session()
    base_rel = get_server_relative_base()
    log(f"[CHECK 2/4] Test SharePoint REST API op '{base_rel}'...")
    folders, files = sp_get_folder_items(session, base_rel)
    ignored_hits = [f["Name"] for f in folders if f["Name"].strip().lower() in IGNORE_FOLDERS]
    log(f"  -> OK: {len(files)} directe bestanden en {len(folders)} submappen gevonden.")
    log(f"[CHECK 3/4] Genegeerde mappen herkend en geblokkeerd: {ignored_hits or sorted(IGNORE_FOLDERS)}")
    log(f"[CHECK 4/4] Test schrijfrechten in {LOCAL_SYNC_DIR}...")
    os.makedirs(LOCAL_SYNC_DIR, exist_ok=True)
    probe = os.path.join(LOCAL_SYNC_DIR, ".sync_write_probe")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("ok")
    os.remove(probe)
    log("[VERIFIED] SharePoint REST API + Okta Cookie Vault werkt zonder Entra App ID.")


def sync_cookie_recursive(
    session: requests.Session,
    server_rel_path: str,
    local_dir: str,
    rel_display: str = "",
) -> tuple[int, int, int, int]:
    os.makedirs(local_dir, exist_ok=True)
    folders, files = sp_get_folder_items(session, server_rel_path)
    visible_folders = [f for f in folders if f["Name"] != "Forms"]
    log(
        f"[SCAN] Map '{rel_display or SHARED_FOLDER}': "
        f"{len(visible_folders)} submappen, {len(files)} bestanden gevonden"
    )

    checked = 0
    downloaded = 0
    unchanged = 0
    ignored = 0

    for folder in folders:
        name = folder["Name"]
        sub_display = f"{rel_display}/{name}" if rel_display else name
        if name.strip().lower() in IGNORE_FOLDERS or name == "Forms":
            if name != "Forms":
                ignored += 1
                log(f"[IGNORE] SharePoint submap overgeslagen: {sub_display}")
            continue
        sub_c, sub_d, sub_u, sub_i = sync_cookie_recursive(
            session,
            f"{server_rel_path}/{name}",
            os.path.join(local_dir, name),
            sub_display,
        )
        checked += sub_c
        downloaded += sub_d
        unchanged += sub_u
        ignored += sub_i

    for f_item in files:
        checked += 1
        fname = f_item["Name"]
        remote_size = int(f_item["Length"])
        target_path = os.path.join(local_dir, fname)
        file_display = f"{rel_display}/{fname}" if rel_display else fname

        if os.path.exists(target_path) and os.path.getsize(target_path) == remote_size:
            unchanged += 1
            log(f"[UP-TO-DATE] {file_display} ({remote_size} B) - al lokaal aanwezig")
            continue

        encoded_rel = encode_odata_path(f"{server_rel_path}/{fname}")
        dl_url = (
            f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/"
            f"GetFileByServerRelativePath(decodedurl='{encoded_rel}')/$value"
        )
        log(f"[DOWNLOAD] {file_display} ({remote_size} B)...")
        with session.get(dl_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(target_path, "wb") as out:
                for chunk in r.iter_content(chunk_size=65536):
                    out.write(chunk)
        downloaded += 1
        log(f"[SYNC] Opgeslagen: {target_path} ({remote_size} B)")

    return checked, downloaded, unchanged, ignored


# ==============================================================================
# MODE 2 (ALTERNATIEF): Microsoft Graph Command Line Tools (14d82eec-...)
# ==============================================================================
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
        print(" [OKTA MFA BOOTSTRAP VIA MICROSOFT GRAPH CLI]")
        print(f" 1. Open op uw pc of telefoon: {flow['verification_uri']}")
        print(f" 2. Voer de eenmalige code in : {flow['user_code']}")
        print(f" 3. Log in als '{USERNAME_HINT}' via {OKTA_URL} en bevestig Okta MFA.")
        print("=" * 72 + "\n", flush=True)

        result = app.acquire_token_by_device_flow(flow)
        if "access_token" not in result:
            err_desc = result.get("error_description", "")
            if "AADSTS65001" in err_desc or "AADSTS65002" in err_desc or "AADSTS53003" in err_desc:
                raise RuntimeError(
                    f"Login geblokkeerd door Entra ID ({result.get('error')}): {err_desc}\n\n"
                    "OPLOSSING ZONDER IT-GOEDKEURING:\n"
                    "Gebruik de directe SharePoint Cookie Vault (0% Entra App consent nodig):\n"
                    "  docker exec -it oktasync python3 /app/sync.py --init-cookies"
                )
            raise RuntimeError(f"Login of Okta MFA mislukt ({result.get('error')}): {err_desc}")

        save_encrypted_token_cache(cache)
        print(f"[SUCCESS] Okta MFA voltooid! Refresh Token versleuteld opgeslagen in {VAULT_FILE}")
        return result["access_token"]

    accounts = app.get_accounts(username=USERNAME_HINT) or app.get_accounts()
    if not accounts:
        raise RuntimeError(
            "Geen sessie gevonden in /vault. Kies bij voorkeur (zonder IT-goedkeuring):\n"
            "  docker exec -it oktasync python3 /app/sync.py --init-cookies"
        )

    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    save_encrypted_token_cache(cache)

    if not result or "access_token" not in result:
        err_code = result.get("error") if result else "no_result"
        err_desc = result.get("error_description") if result else "Onbekende fout"
        raise RuntimeError(f"Stille token-vernieuwing geweigerd ({err_code}): {err_desc}.")
    return result["access_token"]


def list_graph_folder_children(headers: dict, site_id: str, folder_rel_path: str) -> list:
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


def verify_graph_connection() -> None:
    log("[VERIFY] Verbindingstest gestart (Graph OAuth modus)")
    log(f"[CHECK 1/5] Controleer FERNET_VAULT_KEY & versleutelde tokenkluis ({VAULT_FILE})...")
    if not os.path.exists(VAULT_FILE):
        raise RuntimeError(f"Tokenkluis ontbreekt in {VAULT_FILE}. Draai eerst --init-cookies of --init-auth.")
    load_encrypted_token_cache()
    log("  -> OK: Kluis succesvol ontsleuteld.")

    log("[CHECK 2/5] Test stille Okta/Entra OAuth2 token-vernieuwing...")
    token = acquire_graph_token(init_device_flow=False)
    headers = {"Authorization": f"Bearer {token}"}
    log("  -> OK: Vers Access Token verkregen via Refresh Token.")

    log(f"[CHECK 3/5] Verifieer SharePoint site '{TENANT_DOMAIN}/sites/{SITE_NAME}'...")
    site_url = f"https://graph.microsoft.com/v1.0/sites/{TENANT_DOMAIN}:/sites/{SITE_NAME}"
    site_resp = requests.get(site_url, headers=headers, timeout=30)
    site_resp.raise_for_status()
    site_id = site_resp.json()["id"]
    log(f"  -> OK: Site gevonden (ID: {site_id[:32]}...).")

    base_folder = normalize_sharepoint_folder(SHARED_FOLDER)
    log(f"[CHECK 4/5] Lees gedeelde map '/{base_folder}' & controleer ignore-regel...")
    items = list_graph_folder_children(headers, site_id, base_folder)
    ignored_hits = [
        i["name"] for i in items
        if "folder" in i and i["name"].strip().lower() in IGNORE_FOLDERS
    ]
    file_count = sum(1 for i in items if "file" in i)
    folder_count = sum(1 for i in items if "folder" in i)
    log(f"  -> OK: {file_count} directe bestanden en {folder_count} submappen gevonden.")
    log(f"  -> OK: Genegeerde mappen herkend en geblokkeerd: {ignored_hits or sorted(IGNORE_FOLDERS)}")

    log(f"[CHECK 5/5] Test schrijfrechten in lokale Docker mount '{LOCAL_SYNC_DIR}'...")
    os.makedirs(LOCAL_SYNC_DIR, exist_ok=True)
    probe_file = os.path.join(LOCAL_SYNC_DIR, ".sync_write_probe")
    with open(probe_file, "w", encoding="utf-8") as f:
        f.write("ok")
    os.remove(probe_file)
    log("  -> OK: Host bind-mount is beschrijfbaar.")
    log("[VERIFIED] Alle 5 verbindingscontroles geslaagd.")


def sync_graph_recursive(
    headers: dict,
    site_id: str,
    remote_rel_path: str,
    local_dir: str,
    rel_display: str = "",
) -> tuple[int, int, int, int]:
    os.makedirs(local_dir, exist_ok=True)
    items = list_graph_folder_children(headers, site_id, remote_rel_path)
    sub_folders = [i for i in items if "folder" in i]
    sub_files = [i for i in items if "file" in i]
    log(
        f"[SCAN] Map '{rel_display or SHARED_FOLDER}': "
        f"{len(sub_folders)} submappen, {len(sub_files)} bestanden gevonden"
    )

    checked = 0
    downloaded = 0
    unchanged = 0
    ignored = 0

    for item in sub_folders:
        item_name = item["name"]
        sub_display = f"{rel_display}/{item_name}" if rel_display else item_name
        if item_name.strip().lower() in IGNORE_FOLDERS:
            ignored += 1
            log(f"[IGNORE] SharePoint submap overgeslagen: {sub_display}")
            continue
        sub_c, sub_d, sub_u, sub_i = sync_graph_recursive(
            headers,
            site_id,
            f"{remote_rel_path}/{item_name}",
            os.path.join(local_dir, item_name),
            sub_display,
        )
        checked += sub_c
        downloaded += sub_d
        unchanged += sub_u
        ignored += sub_i

    for item in sub_files:
        item_name = item["name"]
        checked += 1
        remote_size = item["size"]
        download_url = item["@microsoft.graph.downloadUrl"]
        target_path = os.path.join(local_dir, item_name)
        file_display = f"{rel_display}/{item_name}" if rel_display else item_name

        if os.path.exists(target_path) and os.path.getsize(target_path) == remote_size:
            unchanged += 1
            log(f"[UP-TO-DATE] {file_display} ({remote_size} B) - al lokaal aanwezig")
            continue

        log(f"[DOWNLOAD] {file_display} ({remote_size} B)...")
        with requests.get(download_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(target_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)

        downloaded += 1
        log(f"[SYNC] Opgeslagen: {target_path} ({remote_size} B)")

    return checked, downloaded, unchanged, ignored


# ==============================================================================
# AUTOMATISCHE SELECTIE & ENTRYPOINT
# ==============================================================================
def active_mode() -> str:
    if os.path.exists(COOKIE_VAULT):
        return "cookie"
    if os.path.exists(VAULT_FILE):
        return "graph"
    return "none"


def verify_connection() -> None:
    mode = active_mode()
    if mode == "cookie":
        verify_cookie_connection()
    elif mode == "graph":
        verify_graph_connection()
    else:
        raise RuntimeError(
            "Nog geen versleutelde sessie gevonden in /vault. "
            "Start eenmalig (aanbevolen, zonder IT-goedkeuring):\n"
            "  docker exec -it oktasync python3 /app/sync.py --init-cookies"
        )


def run_folder_sync(force: bool = False) -> None:
    now = datetime.datetime.now()
    if not force and not (START_HOUR <= now.hour <= END_HOUR):
        log(f"[SKIP] {now.strftime('%H:%M')} valt buiten het actieve venster ({START_HOUR:02d}:00-{END_HOUR:02d}:00).")
        return

    trigger_label = "Handmatige sync (--force)" if force else "Geplande Supercronic sync"
    mode = active_mode()

    if mode == "cookie":
        log(f"[START] {trigger_label} gestart (Cookie Vault)")
        log(f"[INFO] Bron: https://{TENANT_DOMAIN}{get_server_relative_base()}")
        log(f"[INFO] Doel: {LOCAL_SYNC_DIR} | Genegeerd: {sorted(IGNORE_FOLDERS)}")
        session = build_sp_session()
        log(f"[AUTH] SharePoint cookie-kluis ontsleuteld ({COOKIE_VAULT})")
        checked, downloaded, unchanged, ignored = sync_cookie_recursive(
            session, get_server_relative_base(), LOCAL_SYNC_DIR
        )
        log(
            f"[KLAAR] Gecontroleerd: {checked} | Gedownload: {downloaded} | "
            f"Ongewijzigd: {unchanged} | Genegeerde mappen: {ignored}"
        )
        return

    if mode == "graph":
        log(f"[START] {trigger_label} gestart (Graph OAuth)")
        base_folder = normalize_sharepoint_folder(SHARED_FOLDER)
        log(f"[INFO] Bron: https://{TENANT_DOMAIN}/sites/{SITE_NAME} -> /{base_folder}")
        log(f"[INFO] Doel: {LOCAL_SYNC_DIR} | Genegeerd: {sorted(IGNORE_FOLDERS)}")
        token = acquire_graph_token(init_device_flow=False)
        log(f"[AUTH] Access Token verkregen uit kluis ({VAULT_FILE})")
        headers = {"Authorization": f"Bearer {token}"}
        site_url = f"https://graph.microsoft.com/v1.0/sites/{TENANT_DOMAIN}:/sites/{SITE_NAME}"
        site_resp = requests.get(site_url, headers=headers, timeout=30)
        site_resp.raise_for_status()
        site_id = site_resp.json()["id"]

        checked, downloaded, unchanged, ignored = sync_graph_recursive(
            headers, site_id, base_folder, LOCAL_SYNC_DIR
        )
        log(
            f"[KLAAR] Gecontroleerd: {checked} | Gedownload: {downloaded} | "
            f"Ongewijzigd: {unchanged} | Genegeerde mappen: {ignored}"
        )
        return

    raise RuntimeError(
        "Geen geldige sessie in /vault. Voer eenmalig uit:\n"
        "  docker exec -it oktasync python3 /app/sync.py --init-cookies"
    )


if __name__ == "__main__":
    if "--init-cookies" in sys.argv:
        init_cookie_vault()
    elif "--init-auth" in sys.argv:
        acquire_graph_token(init_device_flow=True)
    else:
        try:
            if "--verify" in sys.argv:
                verify_connection()
            else:
                run_folder_sync(force="--force" in sys.argv)
        except Exception as exc:
            log(f"[FOUT] {exc}")
            sys.exit(1)
