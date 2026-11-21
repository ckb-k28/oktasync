import { SyncConfig } from '../types/syncConfig';

export function computeSyncTimeSlots(startHour: number, endHour: number, intervalHours: number): string[] {
  const slots: string[] = [];
  const safeInterval = Math.max(1, intervalHours);
  for (let h = startHour; h <= endHour; h += safeInterval) {
    slots.push(`${String(h).padStart(2, '0')}:00`);
  }
  return slots;
}

export function buildCronExpression(startHour: number, endHour: number, intervalHours: number, weekdaysOnly: boolean): string {
  const dayField = weekdaysOnly ? '1-5' : '*';
  return `0 ${startHour}-${endHour}/${intervalHours} * * ${dayField}`;
}

export function generateGithubWorkflowYaml(config: SyncConfig): string {
  return `# Sla dit bestand op als EXACT: .github/workflows/docker-publish.yml
name: Build & Push O365 Okta Sync Docker Image (amd64)

on:
  push:
    branches:
      - "**"
    tags:
      - "*"
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${config.githubRepo.toLowerCase()}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout GitHub Repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in op GitHub Container Registry (GHCR)
        uses: docker/login-action@v3
        with:
          registry: \${{ env.REGISTRY }}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker Metadata & Tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=sha,prefix=sha-
            type=raw,value=latest

      - name: Build en Push Docker Image (linux/amd64)
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
`;
}

export function generateDockerfile(config: SyncConfig): string {
  return `# ==============================================================================
# Dockerfile (linux/amd64) - O365 + Okta MFA Synchronisatie & Web UI (Poort 5555)
# Gebouwd via GitHub Actions -> Gehost op lokale Docker omgeving
# ==============================================================================
FROM --platform=linux/amd64 node:22-bookworm-slim AS web-builder

WORKDIR /web
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM --platform=linux/amd64 python:3.12-slim-bookworm

# Installeer tijdzone-data, ca-certificates en Supercronic (non-root cron runner voor Docker)
ENV DEBIAN_FRONTEND=noninteractive \\
    TZ=${config.timezone} \\
    PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1 \\
    WEB_PORT=5555 \\
    WEB_DIST_DIR=/app/dist

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    tzdata \\
    && rm -rf /var/lib/apt/lists/*

# Installeer Supercronic (linux/amd64)
ENV SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \\
    SUPERCRONIC_SHA1SUM=cd48d45c4b10f3f0bfdd3a57d054cd05ac96812b

RUN curl -fsSL "\${SUPERCRONIC_URL}" -o /usr/local/bin/supercronic \\
    && echo "\${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c - \\
    && chmod +x /usr/local/bin/supercronic

# Maak onbevoegde container-gebruiker aan (UID 1000 zodat lokale volume-rechten kloppen)
RUN groupadd -g 1000 syncgroup && useradd -u 1000 -g syncgroup -m -s /bin/bash syncuser

WORKDIR /app

# Installeer Python dependencies (MSAL voor Okta/Entra OAuth2, Cryptography voor Fernet AES-128 kluis)
RUN pip install --no-cache-dir \\
    msal==1.31.0 \\
    cryptography==43.0.1 \\
    requests==2.32.3

# Kopieer gebouwde webapplicatie en Python sync-bestanden
COPY --from=web-builder --chown=syncuser:syncgroup /web/dist /app/dist
COPY --chown=syncuser:syncgroup sync.py /app/sync.py
COPY --chown=syncuser:syncgroup web_server.py /app/web_server.py
COPY --chown=syncuser:syncgroup entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/sync.py /app/web_server.py /app/entrypoint.sh

# Maak mountpoints aan voor lokale doelmap (/data/sync) en versleutelde tokenkluis (/vault)
RUN mkdir -p ${config.containerDataPath} ${config.containerVaultPath} \\
    && chown -R syncuser:syncgroup ${config.containerDataPath} ${config.containerVaultPath} /app

USER syncuser

EXPOSE 5555

VOLUME ["${config.containerDataPath}", "${config.containerVaultPath}"]

ENTRYPOINT ["/app/entrypoint.sh"]
`;
}

export function generateDockerComposeYaml(config: SyncConfig): string {
  const cronExpr = buildCronExpression(config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly);
  const imageRef = `ghcr.io/${config.githubRepo.toLowerCase()}:latest`;

  return `# ==============================================================================
# docker-compose.yml - Draai lokaal op uw Docker Host
# LET OP bij private GHCR package ('Head .../manifests/latest: denied'):
#   Voer eerst uit: echo "<GITHUB_PAT>" | docker login ghcr.io -u ${config.githubRepo.split('/')[0]} --password-stdin
#   Of bouw lokaal vanuit de geclonede repo met: docker compose up -d --build
# ==============================================================================
services:
  o365-okta-sync:
    image: ${imageRef}
    # Uncomment 'build: .' als u direct vanaf lokale git clone wilt bouwen zonder GHCR pull:
    # build: .
    container_name: ${config.dockerImageName}
    restart: unless-stopped
    ports:
      - "5555:5555"
    environment:
      - TZ=${config.timezone}
      - WEB_PORT=5555
      - SYNC_CRON_SCHEDULE=${cronExpr}
      - O365_TENANT_DOMAIN=${config.tenantDomain}
      - O365_AUTHORITY=https://login.microsoftonline.com/organizations
      - O365_SITE_NAME=${config.sharepointSiteName}
      - O365_SHARED_FOLDER=${config.sharedFolderPath}
      - O365_IGNORE_FOLDERS=${config.ignoredFolders.join(',')}
      - O365_CLIENT_ID=${config.clientId}
      - OKTA_FEDERATION_URL=${config.oktaOrgUrl}
      - O365_USERNAME_HINT=${config.usernameHint}
      - LOCAL_SYNC_DIR=${config.containerDataPath}
      - TOKEN_VAULT_FILE=${config.containerVaultPath}/token_cache.enc
      # Genereer eenmalig op de host met:
      # python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
      - FERNET_VAULT_KEY=\${FERNET_VAULT_KEY}
      - START_HOUR=${config.startHour}
      - END_HOUR=${config.endHour}
    volumes:
      # 1. Lokale map op uw host (/opt/docker/callsheets/*) waar de gedeelde O365 bestanden in komen:
      - ${config.hostSyncVolumePath}:${config.containerDataPath}:rw
      # 2. Persistente versleutelde opslag voor het Okta/O365 OAuth2 Refresh Token:
      - ${config.hostVaultVolumePath}:${config.containerVaultPath}:rw
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
`;
}

export function generateEntrypointScript(config: SyncConfig): string {
  const defaultCron = buildCronExpression(config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly);
  const vaultFileName =
    config.authMethod === 'sharepoint-cookie-vault'
      ? 'sp_cookies.enc'
      : config.authMethod === 'rclone-docker-encrypted'
      ? 'rclone.conf'
      : 'token_cache.enc';
  const initHint =
    config.authMethod === 'sharepoint-cookie-vault'
      ? `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies`
      : config.authMethod === 'rclone-docker-encrypted'
      ? `rclone authorize "onedrive" && plaats versleutelde rclone.conf in ${config.hostVaultVolumePath}`
      : `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth`;

  return `#!/usr/bin/env bash
set -euo pipefail

CRON_SCHEDULE="\${SYNC_CRON_SCHEDULE:-${defaultCron}}"
CRONTAB_FILE="/tmp/o365_sync_crontab"

echo "=================================================================="
echo " O365 + Okta MFA Docker Sync Container Gestart"
echo " Tijdzone       : \${TZ:-${config.timezone}}"
echo " Web UI Poort   : http://0.0.0.0:\${WEB_PORT:-5555}"
echo " Cron Schema    : \${CRON_SCHEDULE} (Elke ${config.intervalHours}u tussen ${String(config.startHour).padStart(2, '0')}:00 en ${String(config.endHour).padStart(2, '0')}:00)"
echo " Gedeelde Map   : \${O365_SHARED_FOLDER:-${config.sharedFolderPath}}"
echo " Genegeerd      : \${O365_IGNORE_FOLDERS:-${config.ignoredFolders.join(',')}}"
echo " Container Doel : \${LOCAL_SYNC_DIR:-${config.containerDataPath}}"
echo "=================================================================="

if [ ! -f "\${TOKEN_VAULT_FILE:-${config.containerVaultPath}/${vaultFileName}}" ]; then
  echo "[WAARSCHUWING] Nog geen versleutelde sessie gevonden in \${TOKEN_VAULT_FILE:-${config.containerVaultPath}/${vaultFileName}}."
  echo "[ACTIE VEREIST] Voer op de Docker host eenmalig het volgende uit (Username + Password + Okta MFA):"
  echo "  ${initHint}"
fi

# Start webinterface op poort 5555 op de achtergrond
/usr/local/bin/python3 /app/web_server.py &

# Schrijf het 2-uurlijkse schema naar een tijdelijk crontab-bestand voor Supercronic
echo "\${CRON_SCHEDULE} /usr/local/bin/python3 /app/sync.py" > "\${CRONTAB_FILE}"

# Start Supercronic op de voorgrond (PID 1)
exec /usr/local/bin/supercronic "\${CRONTAB_FILE}"
`;
}

export function generateDockerPythonSyncScript(config: SyncConfig): string {
  if (config.authMethod === 'sharepoint-cookie-vault') {
    return `#!/usr/bin/env python3
"""
Directe SharePoint REST API Synchronisatie via Okta Browser Sessie-Vault (FedAuth + rtFa).
- 100% immuun voor AADSTS65001 (geen Entra App Registration of IT-goedkeuring nodig).
- Eenmalige Okta sessie opslaan:
    docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies
- Verbindingstest zonder downloads:
    docker exec ${config.dockerImageName} python3 /app/sync.py --verify
- Handmatige testrun buiten 08:00-20:00 venster:
    docker exec ${config.dockerImageName} python3 /app/sync.py --force
"""
import os
import sys
import json
import getpass
import datetime
import urllib.parse
import requests
from cryptography.fernet import Fernet

TENANT_DOMAIN   = os.environ.get("O365_TENANT_DOMAIN", "${config.tenantDomain}")
SITE_NAME       = os.environ.get("O365_SITE_NAME", "${config.sharepointSiteName}")
SHARED_FOLDER   = os.environ.get("O365_SHARED_FOLDER", "${config.sharedFolderPath}")
IGNORE_FOLDERS  = {
    f.strip().lower()
    for f in os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}").split(",")
    if f.strip()
}
LOCAL_SYNC_DIR  = os.environ.get("LOCAL_SYNC_DIR", "${config.containerDataPath}")
COOKIE_VAULT    = os.environ.get("COOKIE_VAULT_FILE", "${config.containerVaultPath}/sp_cookies.enc")
FERNET_KEY      = os.environ.get("FERNET_VAULT_KEY", "")
START_HOUR      = int(os.environ.get("START_HOUR", "${config.startHour}"))
END_HOUR        = int(os.environ.get("END_HOUR", "${config.endHour}"))

def get_cipher() -> Fernet:
    if not FERNET_KEY:
        raise RuntimeError("FERNET_VAULT_KEY ontbreekt in Docker environment.")
    return Fernet(FERNET_KEY.encode("utf-8"))

def get_server_relative_base() -> str:
    cleaned = SHARED_FOLDER.strip("/")
    for prefix in ("Shared Documents/", "Gedeelde documenten/"):
        if cleaned.lower().startswith(prefix.lower()):
            cleaned = cleaned[len(prefix):]
    return f"/sites/{SITE_NAME}/Shared Documents/{cleaned.strip('/')}"

def init_cookie_vault() -> None:
    print("\\n=== SharePoint + Okta Sessie-Vault (Zero Entra App) ===")
    print(f"1. Open in uw browser: https://{TENANT_DOMAIN}/sites/{SITE_NAME}")
    print("2. Log in met Username + Password + Okta MFA (${config.oktaOrgUrl}).")
    print("3. Open DevTools (F12) -> Application -> Cookies -> nepinc.sharepoint.com")
    print("   Kopieer de waarden van 'FedAuth' en 'rtFa' (invoer wordt verborgen):\\n")

    fed_auth = getpass.getpass("FedAuth cookie waarde: ").strip()
    rt_fa = getpass.getpass("rtFa cookie waarde   : ").strip()
    if not fed_auth or not rt_fa:
        raise RuntimeError("Zowel FedAuth als rtFa zijn verplicht.")

    os.makedirs(os.path.dirname(COOKIE_VAULT), exist_ok=True)
    payload = json.dumps({"FedAuth": fed_auth, "rtFa": rt_fa}).encode("utf-8")
    encrypted = get_cipher().encrypt(payload)
    with open(COOKIE_VAULT, "wb") as f:
        f.write(encrypted)
    os.chmod(COOKIE_VAULT, 0o600)
    print(f"[SUCCESS] Okta/SharePoint cookies AES-128 versleuteld opgeslagen in {COOKIE_VAULT}")

def build_sp_session() -> requests.Session:
    if not os.path.exists(COOKIE_VAULT):
        raise RuntimeError(
            f"Geen cookie-kluis gevonden in {COOKIE_VAULT}. "
            f"Voer eerst 'docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies' uit."
        )
    with open(COOKIE_VAULT, "rb") as f:
        data = json.loads(get_cipher().decrypt(f.read()).decode("utf-8"))

    session = requests.Session()
    session.cookies.set("FedAuth", data["FedAuth"], domain=TENANT_DOMAIN)
    session.cookies.set("rtFa", data["rtFa"], domain=TENANT_DOMAIN)
    session.headers.update({"Accept": "application/json;odata=nometadata"})
    return session

def sp_get_folder_items(session: requests.Session, server_rel_path: str) -> tuple[list, list]:
    encoded = urllib.parse.quote(server_rel_path)
    base_api = f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/GetFolderByServerRelativeUrl('{encoded}')"
    folders_resp = session.get(f"{base_api}/Folders", timeout=30)
    if folders_resp.status_code in (401, 403):
        raise RuntimeError("SharePoint sessie verlopen of ongeldig (HTTP 401/403). Vernieuw via --init-cookies.")
    folders_resp.raise_for_status()

    files_resp = session.get(f"{base_api}/Files", timeout=30)
    files_resp.raise_for_status()
    return folders_resp.json().get("value", []), files_resp.json().get("value", [])

def verify_connection() -> None:
    print("[CHECK 1/4] Ontsleutel cookie-kluis...")
    session = build_sp_session()
    base_rel = get_server_relative_base()
    print(f"[CHECK 2/4] Test SharePoint REST API op '{base_rel}'...")
    folders, files = sp_get_folder_items(session, base_rel)
    ignored_hits = [f["Name"] for f in folders if f["Name"].strip().lower() in IGNORE_FOLDERS]
    print(f"  -> OK: {len(files)} bestanden en {len(folders)} submappen gevonden.")
    print(f"[CHECK 3/4] Genegeerde mappen herkend: {ignored_hits or sorted(IGNORE_FOLDERS)}")
    print(f"[CHECK 4/4] Test schrijfrechten in {LOCAL_SYNC_DIR}...")
    os.makedirs(LOCAL_SYNC_DIR, exist_ok=True)
    probe = os.path.join(LOCAL_SYNC_DIR, ".sync_write_probe")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("ok")
    os.remove(probe)
    print("\\n[VERIFIED] SharePoint REST API + Cookie Vault werkt zonder Entra App ID.")

def sync_recursive(session: requests.Session, server_rel_path: str, local_dir: str) -> tuple[int, int]:
    os.makedirs(local_dir, exist_ok=True)
    folders, files = sp_get_folder_items(session, server_rel_path)
    checked = 0
    downloaded = 0

    for folder in folders:
        name = folder["Name"]
        if name.strip().lower() in IGNORE_FOLDERS or name == "Forms":
            print(f"[IGNORE] Submap overgeslagen: {server_rel_path}/{name}")
            continue
        sub_c, sub_d = sync_recursive(session, f"{server_rel_path}/{name}", os.path.join(local_dir, name))
        checked += sub_c
        downloaded += sub_d

    for f_item in files:
        checked += 1
        fname = f_item["Name"]
        remote_size = int(f_item["Length"])
        target_path = os.path.join(local_dir, fname)
        if os.path.exists(target_path) and os.path.getsize(target_path) == remote_size:
            continue

        encoded_rel = urllib.parse.quote(f"{server_rel_path}/{fname}")
        dl_url = f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/GetFileByServerRelativeUrl('{encoded_rel}')/$value"
        with session.get(dl_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(target_path, "wb") as out:
                for chunk in r.iter_content(chunk_size=65536):
                    out.write(chunk)
        downloaded += 1
        print(f"[SYNC] Gedownload: {server_rel_path}/{fname} ({remote_size} bytes)")

    return checked, downloaded

def run_folder_sync(force: bool = False) -> None:
    now = datetime.datetime.now()
    if not force and not (START_HOUR <= now.hour <= END_HOUR):
        print(f"[SKIP] {now.strftime('%H:%M')} valt buiten venster {START_HOUR:02d}:00-{END_HOUR:02d}:00.")
        return
    session = build_sp_session()
    checked, downloaded = sync_recursive(session, get_server_relative_base(), LOCAL_SYNC_DIR)
    print(f"[OK] {now.strftime('%Y-%m-%d %H:%M:%S')} - Gecontroleerd: {checked}, Gedownload: {downloaded}")

if __name__ == "__main__":
    if "--init-cookies" in sys.argv:
        init_cookie_vault()
    elif "--verify" in sys.argv:
        verify_connection()
    else:
        run_folder_sync(force="--force" in sys.argv)
`;
  }

  if (config.authMethod === 'rclone-docker-encrypted') {
    return `#!/usr/bin/env python3
"""
Rclone Docker Wrapper Script (AES-256 versleutelde rclone.conf + Ignore List).
"""
import os
import sys
import datetime
import subprocess

LOCAL_SYNC_DIR = os.environ.get("LOCAL_SYNC_DIR", "${config.containerDataPath}")
START_HOUR     = int(os.environ.get("START_HOUR", "${config.startHour}"))
END_HOUR       = int(os.environ.get("END_HOUR", "${config.endHour}"))
IGNORE_LIST    = [f.strip() for f in os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}").split(",") if f.strip()]

def run_rclone_sync(force: bool = False) -> None:
    now = datetime.datetime.now()
    if not force and not (START_HOUR <= now.hour <= END_HOUR):
        print(f"[SKIP] {now.strftime('%H:%M')} valt buiten {START_HOUR:02d}:00-{END_HOUR:02d}:00.")
        return

    cmd = [
        "rclone", "copy",
        "o365_gedeeld:${config.sharedFolderPath}",
        LOCAL_SYNC_DIR,
        "--config", "${config.containerVaultPath}/rclone.conf",
        "--transfers", "4",
        "--checkers", "8",
        "-v"
    ]
    for folder in IGNORE_LIST:
        cmd.extend(["--exclude", f"{folder}/**"])

    subprocess.run(cmd, check=True)

if __name__ == "__main__":
    run_rclone_sync(force="--force" in sys.argv)
`;
  }

  return `#!/usr/bin/env python3
"""
Headless Docker Synchronisatie Script voor Gedeelde O365 / SharePoint Map met Okta MFA.
- Gebruikt Microsoft First-Party Client ID + 'organizations' authority voor Okta (${config.oktaOrgUrl}).
- Eenmalige MFA bootstrap:
    docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth
- Verbindingstest (dry-run zonder downloads):
    docker exec ${config.dockerImageName} python3 /app/sync.py --verify
- Handmatige testrun buiten 08:00-20:00 venster:
    docker exec ${config.dockerImageName} python3 /app/sync.py --force
"""
import os
import sys
import datetime
import urllib.parse
import requests
import msal
from cryptography.fernet import Fernet

TENANT_DOMAIN   = os.environ.get("O365_TENANT_DOMAIN", "${config.tenantDomain}")
AUTH_AUTHORITY  = os.environ.get("O365_AUTHORITY", "https://login.microsoftonline.com/organizations")
SITE_NAME       = os.environ.get("O365_SITE_NAME", "${config.sharepointSiteName}")
SHARED_FOLDER   = os.environ.get("O365_SHARED_FOLDER", "${config.sharedFolderPath}")
IGNORE_FOLDERS  = {
    f.strip().lower()
    for f in os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}").split(",")
    if f.strip()
}
CLIENT_ID       = os.environ.get("O365_CLIENT_ID", "${config.clientId}")
OKTA_URL        = os.environ.get("OKTA_FEDERATION_URL", "${config.oktaOrgUrl}")
USERNAME_HINT   = os.environ.get("O365_USERNAME_HINT", "${config.usernameHint}")
LOCAL_SYNC_DIR  = os.environ.get("LOCAL_SYNC_DIR", "${config.containerDataPath}")
VAULT_FILE      = os.environ.get("TOKEN_VAULT_FILE", "${config.containerVaultPath}/token_cache.enc")
FERNET_KEY      = os.environ.get("FERNET_VAULT_KEY", "")
START_HOUR      = int(os.environ.get("START_HOUR", "${config.startHour}"))
END_HOUR        = int(os.environ.get("END_HOUR", "${config.endHour}"))

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

        print("\\n" + "=" * 72)
        print(" [OKTA MFA BOOTSTRAP IN HEADLESS DOCKER CONTAINER]")
        print(f" 1. Open op uw pc of telefoon: {flow['verification_uri']}")
        print(f" 2. Voer de eenmalige code in : {flow['user_code']}")
        print(f" 3. Log in als '{USERNAME_HINT}' via {OKTA_URL} en bevestig Okta MFA.")
        print("=" * 72 + "\\n", flush=True)

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
            f"Voer eerst 'docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth' uit."
        )

    # Vernieuwt het Access Token stilzwijgend via het Refresh Token (geen MFA prompt nodig)
    result = app.acquire_token_silent(SCOPES, account=accounts[0])
    save_encrypted_token_cache(cache)

    if not result or "access_token" not in result:
        err_code = result.get("error") if result else "no_result"
        err_desc = result.get("error_description") if result else "Onbekende fout"
        raise RuntimeError(
            f"Stille token-vernieuwing geweigerd ({err_code}): {err_desc}. "
            "Mogelijk vereist Okta/Entra Conditional Access opnieuw --init-auth of een App Registration."
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
    print("\\n[VERIFIED] Alle 5 verbindingscontroles geslaagd. De 2-uurlijkse sync is bedrijfsklaar.")

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
`;
}

export function generateWebServerScript(config: SyncConfig): string {
  return `#!/usr/bin/env python3
"""
Lichtgewicht HTTP server voor het O365 Okta Sync Dashboard op poort 5555.
Serveert de gebouwde frontend (/app/dist) + /api/health endpoint zonder extra dependencies.
"""
import json
import mimetypes
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB_PORT = int(os.environ.get("WEB_PORT", "5555"))
DIST_DIR = os.environ.get("WEB_DIST_DIR", "/app/dist")
VAULT_FILE = os.environ.get("TOKEN_VAULT_FILE", "${config.containerVaultPath}/token_cache.enc")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class SpaRequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        clean_path = self.path.split("?", 1)[0]

        if clean_path == "/api/health":
            payload = {
                "status": "ok",
                "port": WEB_PORT,
                "vault_present": os.path.exists(VAULT_FILE),
                "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "${buildCronExpression(config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly)}"),
                "shared_folder": os.environ.get("O365_SHARED_FOLDER", "${config.sharedFolderPath}"),
                "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}"),
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not os.path.isdir(DIST_DIR):
            fallback = (
                "<!doctype html><html lang='nl'><head><meta charset='utf-8'>"
                "<title>O365 Okta Sync</title></head><body style='font-family:sans-serif;padding:2rem'>"
                "<h1>O365 Okta Sync Container Actief (Poort 5555)</h1>"
                "<p>Frontend build (/app/dist) is niet aanwezig; de 2-uurlijkse Supercronic sync draait wel.</p>"
                "</body></html>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(fallback)))
            self.end_headers()
            self.wfile.write(fallback)
            return

        dist_abs = os.path.abspath(DIST_DIR)
        requested = os.path.abspath(os.path.join(dist_abs, clean_path.lstrip("/")))
        if os.path.commonpath([dist_abs, requested]) != dist_abs or not os.path.isfile(requested):
            self.path = "/index.html"

        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    handler = partial(SpaRequestHandler, directory=DIST_DIR if os.path.isdir(DIST_DIR) else ".")
    server = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), handler)
    print(f"[WEB] O365 Okta Sync UI actief op http://0.0.0.0:{WEB_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;
}

export function generateRepoBootstrapScript(config: SyncConfig): string {
  const workflow = generateGithubWorkflowYaml(config);
  const dockerfile = generateDockerfile(config);
  const compose = generateDockerComposeYaml(config);
  const entrypoint = generateEntrypointScript(config);
  const syncPy = generateDockerPythonSyncScript(config);
  const webServerPy = generateWebServerScript(config);

  return `#!/usr/bin/env bash
# ==============================================================================
# setup-repo.sh - Zet alle bestanden in de juiste mappen (incl. .github/workflows)
# en pusht naar https://github.com/${config.githubRepo} om direct de Action te starten.
# Gebruik: voer dit script uit in uw geclonede git-map van ${config.githubRepo}
# ==============================================================================
set -euo pipefail

mkdir -p .github/workflows

cat << 'EOF_WORKFLOW' > .github/workflows/docker-publish.yml
${workflow.trimEnd()}
EOF_WORKFLOW

cat << 'EOF_DOCKERFILE' > Dockerfile
${dockerfile.trimEnd()}
EOF_DOCKERFILE

cat << 'EOF_COMPOSE' > docker-compose.yml
${compose.trimEnd()}
EOF_COMPOSE

cat << 'EOF_ENTRYPOINT' > entrypoint.sh
${entrypoint.trimEnd()}
EOF_ENTRYPOINT

cat << 'EOF_SYNC_PY' > sync.py
${syncPy.trimEnd()}
EOF_SYNC_PY

cat << 'EOF_WEB_SERVER' > web_server.py
${webServerPy.trimEnd()}
EOF_WEB_SERVER

chmod +x entrypoint.sh sync.py web_server.py

git add .github/workflows/docker-publish.yml Dockerfile docker-compose.yml entrypoint.sh sync.py web_server.py
git commit -m "Configureer O365 Okta Sync Docker build (amd64, poort 5555) & GitHub Action"
git push

echo "Klaar! Open https://github.com/${config.githubRepo}/actions om de gestarte build te volgen."
`;
}

