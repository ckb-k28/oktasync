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
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${config.githubRepo.toLowerCase()}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write

    steps:
      - name: Checkout GitHub Repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Bepaal volgend versienummer (start bij v.01)
        id: version
        run: |
          git fetch --tags --force || true
          TAG_NUM=$(git tag -l 'v.[0-9]*' | sed -E 's/^v\\.0*([0-9]+)$/\\1/' | grep -E '^[0-9]+$' | sort -n | tail -n 1 || true)
          TAG_NUM=\${TAG_NUM:-0}
          FILE_NUM=0
          if [ -f VERSION ]; then
            FILE_NUM=$(tr -d '[:space:]' < VERSION | sed -E 's/^v\\.0*([0-9]+)$/\\1/' | grep -E '^[0-9]+$' || true)
            FILE_NUM=\${FILE_NUM:-0}
          fi
          RUN_NUM="\${{ github.run_number }}"
          NEXT_NUM=$((TAG_NUM + 1))
          if [ "$RUN_NUM" -gt "$NEXT_NUM" ]; then
            NEXT_NUM="$RUN_NUM"
          fi
          if [ "$FILE_NUM" -gt "$NEXT_NUM" ]; then
            NEXT_NUM="$FILE_NUM"
          fi
          NEXT_VERSION=$(printf "v.%02d" "$NEXT_NUM")
          printf "%s\\n" "$NEXT_VERSION" > VERSION
          echo "version=\${NEXT_VERSION}" >> "$GITHUB_OUTPUT"
          echo "Toegewezen release-versie: \${NEXT_VERSION} (tag=$TAG_NUM, file=$FILE_NUM, run=$RUN_NUM)"
          echo "### Build Versie: \${NEXT_VERSION}" >> "$GITHUB_STEP_SUMMARY"

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Log in op GitHub Container Registry (GHCR)
        uses: docker/login-action@v4
        with:
          registry: \${{ env.REGISTRY }}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Extract Docker Metadata & Tags
        id: meta
        uses: docker/metadata-action@v6
        with:
          images: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=\${{ steps.version.outputs.version }}
            type=ref,event=branch
            type=sha,prefix=sha-
            type=raw,value=latest
          labels: |
            org.opencontainers.image.version=\${{ steps.version.outputs.version }}

      - name: Build en Push Docker Image (linux/amd64)
        uses: docker/build-push-action@v7
        with:
          context: .
          platforms: linux/amd64
          push: true
          build-args: |
            APP_VERSION=\${{ steps.version.outputs.version }}
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Push Git Versie-tag (\${{ steps.version.outputs.version }})
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git tag -fa "\${{ steps.version.outputs.version }}" -m "Release \${{ steps.version.outputs.version }}"
          git push origin "refs/tags/\${{ steps.version.outputs.version }}" --force || echo "::warning::Kon git tag niet pushen (controleer Actions write permissions); github.run_number blijft versienummer verhogen."
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
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY VERSION ./
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
ARG APP_VERSION=""
RUN if [ -n "$APP_VERSION" ]; then printf '%s\\n' "$APP_VERSION" > VERSION; fi
ENV VITE_APP_VERSION=\${APP_VERSION}
RUN npm run build

FROM --platform=linux/amd64 python:3.12-slim-bookworm

ARG APP_VERSION=""

# Installeer tijdzone-data, ca-certificates en Supercronic (non-root cron runner voor Docker)
ENV DEBIAN_FRONTEND=noninteractive \\
    TZ=${config.timezone} \\
    PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1 \\
    APP_VERSION=\${APP_VERSION} \\
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

WORKDIR /app

# Installeer Python dependencies (MSAL voor Okta/Entra OAuth2, Cryptography voor Fernet AES-128 kluis)
RUN pip install --no-cache-dir \\
    msal==1.31.0 \\
    cryptography==43.0.1 \\
    requests==2.32.3

# Kopieer gebouwde webapplicatie en Python sync-bestanden
COPY --from=web-builder /web/dist /app/dist
COPY --from=web-builder /web/VERSION /app/VERSION
COPY sync.py /app/sync.py
COPY web_server.py /app/web_server.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/sync.py /app/web_server.py /app/entrypoint.sh

# Maak mountpoints aan voor lokale doelmap (/data/sync) en versleutelde tokenkluis (/vault)
RUN mkdir -p ${config.containerDataPath} ${config.containerVaultPath}

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
      - HOST_SYNC_DIR=${config.hostSyncVolumePath}
      - TOKEN_VAULT_FILE=${config.containerVaultPath}/token_cache.enc
      - COOKIE_VAULT_FILE=${config.containerVaultPath}/sp_cookies.enc
      # Genereer eenmalig op de host met:
      # python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
      - FERNET_VAULT_KEY=\${FERNET_VAULT_KEY}
      - START_HOUR=${config.startHour}
      - END_HOUR=${config.endHour}
    volumes:
      # 1. Lokale map op uw host (/opt/docker/callsheets/data) waar de gedeelde O365 bestanden in komen:
      - ${config.hostSyncVolumePath}:${config.containerDataPath}:rw
      # 2. Persistente versleutelde opslag (/opt/docker/callsheets/vault) voor de Okta/O365 sessiekluis:
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
RESOLVED_VERSION="\${APP_VERSION:-$(cat /app/VERSION 2>/dev/null || echo v.01)}"

echo "=================================================================="
echo " O365 + Okta MFA Docker Sync Container Gestart (\${RESOLVED_VERSION})"
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
SYNC_LOG_FILE   = os.environ.get("SYNC_LOG_FILE", "/tmp/oktasync.log")

def log(message: str) -> None:
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = message.splitlines() or [""]
    formatted = "\\n".join(f"[{ts}] {line}" if line else "" for line in lines)
    print(formatted, flush=True)
    try:
        log_dir = os.path.dirname(SYNC_LOG_FILE)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        with open(SYNC_LOG_FILE, "a", encoding="utf-8") as lf:
            lf.write(formatted + "\\n")
    except OSError:
        pass

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

def encode_odata_path(path_value: str) -> str:
    escaped = path_value.replace("'", "''")
    return urllib.parse.quote(escaped, safe="/")

def sp_get_folder_items(session: requests.Session, server_rel_path: str) -> tuple[list, list]:
    encoded = encode_odata_path(server_rel_path)
    base_api = f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/GetFolderByServerRelativePath(decodedurl='{encoded}')"
    folders_resp = session.get(f"{base_api}/Folders", timeout=30)
    if folders_resp.status_code in (401, 403):
        raise RuntimeError("SharePoint sessie verlopen of ongeldig (HTTP 401/403). Vernieuw via --init-cookies.")
    folders_resp.raise_for_status()

    files_resp = session.get(f"{base_api}/Files", timeout=30)
    files_resp.raise_for_status()
    return folders_resp.json().get("value", []), files_resp.json().get("value", [])

def verify_connection() -> None:
    log("[VERIFY] Verbindingstest gestart (Cookie Vault modus)")
    log(f"[CHECK 1/4] Ontsleutel cookie-kluis ({COOKIE_VAULT})...")
    session = build_sp_session()
    base_rel = get_server_relative_base()
    log(f"[CHECK 2/4] Test SharePoint REST API op '{base_rel}'...")
    folders, files = sp_get_folder_items(session, base_rel)
    ignored_hits = [f["Name"] for f in folders if f["Name"].strip().lower() in IGNORE_FOLDERS]
    log(f"  -> OK: {len(files)} bestanden en {len(folders)} submappen gevonden.")
    log(f"[CHECK 3/4] Genegeerde mappen herkend: {ignored_hits or sorted(IGNORE_FOLDERS)}")
    log(f"[CHECK 4/4] Test schrijfrechten in {LOCAL_SYNC_DIR}...")
    os.makedirs(LOCAL_SYNC_DIR, exist_ok=True)
    probe = os.path.join(LOCAL_SYNC_DIR, ".sync_write_probe")
    with open(probe, "w", encoding="utf-8") as f:
        f.write("ok")
    os.remove(probe)
    log("[VERIFIED] SharePoint REST API + Cookie Vault werkt zonder Entra App ID.")

def sync_recursive(session: requests.Session, server_rel_path: str, local_dir: str, rel_display: str = "") -> tuple[int, int, int, int]:
    os.makedirs(local_dir, exist_ok=True)
    folders, files = sp_get_folder_items(session, server_rel_path)
    visible_folders = [f for f in folders if f["Name"] != "Forms"]
    log(f"[SCAN] Map '{rel_display or SHARED_FOLDER}': {len(visible_folders)} submappen, {len(files)} bestanden gevonden")
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
        sub_c, sub_d, sub_u, sub_i = sync_recursive(session, f"{server_rel_path}/{name}", os.path.join(local_dir, name), sub_display)
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
        dl_url = f"https://{TENANT_DOMAIN}/sites/{SITE_NAME}/_api/web/GetFileByServerRelativePath(decodedurl='{encoded_rel}')/$value"
        log(f"[DOWNLOAD] {file_display} ({remote_size} B)...")
        with session.get(dl_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(target_path, "wb") as out:
                for chunk in r.iter_content(chunk_size=65536):
                    out.write(chunk)
        downloaded += 1
        log(f"[SYNC] Opgeslagen: {target_path} ({remote_size} B)")

    return checked, downloaded, unchanged, ignored

def run_folder_sync(force: bool = False) -> None:
    now = datetime.datetime.now()
    if not force and not (START_HOUR <= now.hour <= END_HOUR):
        log(f"[SKIP] {now.strftime('%H:%M')} valt buiten venster {START_HOUR:02d}:00-{END_HOUR:02d}:00.")
        return
    trigger_label = "Handmatige sync (--force)" if force else "Geplande Supercronic sync"
    log(f"[START] {trigger_label} gestart (Cookie Vault)")
    log(f"[INFO] Bron: https://{TENANT_DOMAIN}{get_server_relative_base()}")
    log(f"[INFO] Doel: {LOCAL_SYNC_DIR} | Genegeerd: {sorted(IGNORE_FOLDERS)}")
    session = build_sp_session()
    log(f"[AUTH] SharePoint cookie-kluis ontsleuteld ({COOKIE_VAULT})")
    checked, downloaded, unchanged, ignored = sync_recursive(session, get_server_relative_base(), LOCAL_SYNC_DIR)
    log(f"[KLAAR] Gecontroleerd: {checked} | Gedownload: {downloaded} | Ongewijzigd: {unchanged} | Genegeerde mappen: {ignored}")

if __name__ == "__main__":
    if "--init-cookies" in sys.argv:
        init_cookie_vault()
    else:
        try:
            if "--verify" in sys.argv:
                verify_connection()
            else:
                run_folder_sync(force="--force" in sys.argv)
        except Exception as exc:
            log(f"[FOUT] {exc}")
            sys.exit(1)
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
  const defaultCron = buildCronExpression(config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly);
  return `#!/usr/bin/env python3
"""
Lichtgewicht HTTP server voor het O365 Okta Sync Dashboard op poort 5555.
Serveert de gebouwde frontend (/app/dist) en biedt echte container-endpoints:
- GET  /api/health
- GET  /api/status
- GET  /api/files?path=/...          (strikte filebrowser binnen LOCAL_SYNC_DIR)
- GET  /api/files/download?path=/... (strikte download binnen LOCAL_SYNC_DIR)
- POST /api/sync
- POST /api/logs/clear
"""
import datetime
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import urllib.parse
from collections import deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB_PORT = int(os.environ.get("WEB_PORT", "5555"))
DIST_DIR = os.environ.get("WEB_DIST_DIR", "/app/dist")
LOCAL_SYNC_DIR = os.environ.get("LOCAL_SYNC_DIR", "${config.containerDataPath}")
HOST_SYNC_DIR_LABEL = os.environ.get("HOST_SYNC_DIR", "${config.hostSyncVolumePath}")
VAULT_FILE = os.environ.get("TOKEN_VAULT_FILE", "${config.containerVaultPath}/token_cache.enc")
COOKIE_VAULT = os.environ.get("COOKIE_VAULT_FILE", "${config.containerVaultPath}/sp_cookies.enc")
SYNC_SCRIPT = os.environ.get("SYNC_SCRIPT_PATH", "/app/sync.py")
SYNC_LOG_FILE = os.environ.get("SYNC_LOG_FILE", "/tmp/oktasync.log")

ALLOWED_SYNC_MODES = {
    "force": "--force",
    "verify": "--verify",
}
MAX_OUTPUT_LINES = 300
MAX_RUN_HISTORY = 15
SYNC_TIMEOUT_SECONDS = 600


def get_app_version() -> str:
    env_ver = os.environ.get("APP_VERSION", "").strip()
    if env_ver:
        return env_ver
    version_file = "/app/VERSION"
    if os.path.isfile(version_file):
        with open(version_file, "r", encoding="utf-8") as f:
            return f.read().strip() or "v.01"
    return "v.01"


APP_VERSION = get_app_version()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

SYNC_LOCK = threading.Lock()
SYNC_STATE: dict = {
    "running": False,
    "mode": None,
    "command": None,
    "started_at": None,
    "finished_at": None,
    "exit_code": None,
    "output_lines": [],
    "runs": [],
}


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def get_vault_info() -> tuple[bool, str | None, str | None]:
    for path, label in ((COOKIE_VAULT, "sp_cookies.enc"), (VAULT_FILE, "token_cache.enc")):
        if os.path.isfile(path):
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(path)).astimezone().isoformat(timespec="seconds")
            return True, label, mtime
    return False, None, None


def read_sync_log(max_lines: int = MAX_OUTPUT_LINES) -> str:
    if os.path.isfile(SYNC_LOG_FILE):
        try:
            with open(SYNC_LOG_FILE, "r", encoding="utf-8", errors="replace") as lf:
                tail = deque((line.rstrip("\\r\\n") for line in lf), maxlen=max_lines)
            if tail:
                return "\\n".join(tail)
        except OSError:
            pass
    return "\\n".join(SYNC_STATE["output_lines"])


def _get_sync_root_real() -> str:
    return os.path.realpath(LOCAL_SYNC_DIR)


def resolve_safe_sync_path(requested_rel_path: str) -> tuple[str, str]:
    """
    Lost een relatief pad strikt op binnen LOCAL_SYNC_DIR (/data/sync <-> ${config.hostSyncVolumePath}).
    Blokkeert '..', null-bytes, symlinks en pad-ontsnappingen.
    """
    if "\\x00" in requested_rel_path:
        raise PermissionError("Ongeldig pad.")

    base_real = _get_sync_root_real()
    normalized = requested_rel_path.replace("\\\\", "/").strip()
    parts = [p for p in normalized.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise PermissionError(f"Toegang buiten {HOST_SYNC_DIR_LABEL} is geblokkeerd.")

    candidate_joined = os.path.join(base_real, *parts) if parts else base_real

    check_path = base_real
    for part in parts:
        check_path = os.path.join(check_path, part)
        if os.path.islink(check_path):
            raise PermissionError("Symlinks zijn niet toegestaan in de filebrowser.")

    target_real = os.path.realpath(candidate_joined)
    if target_real != base_real and not target_real.startswith(base_real + os.sep):
        raise PermissionError(f"Toegang buiten {HOST_SYNC_DIR_LABEL} is geblokkeerd.")

    clean_rel = "/" + "/".join(parts) if parts else "/"
    return target_real, clean_rel


def scan_local_files(limit: int = 200) -> tuple[list[dict], int, int]:
    base_real = _get_sync_root_real()
    if not os.path.isdir(base_real):
        return [], 0, 0

    items: list[dict] = []
    total_count = 0
    total_bytes = 0

    for root, dirs, filenames in os.walk(base_real, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d))]
        for fname in filenames:
            if fname.startswith("."):
                continue
            full_path = os.path.join(root, fname)
            if os.path.islink(full_path):
                continue
            try:
                full_real = os.path.realpath(full_path)
                if not full_real.startswith(base_real + os.sep):
                    continue
                stat = os.stat(full_real)
            except OSError:
                continue

            total_count += 1
            total_bytes += stat.st_size
            rel_path = os.path.relpath(full_real, base_real).replace(os.sep, "/")
            mod_dt = datetime.datetime.fromtimestamp(stat.st_mtime).astimezone()
            items.append(
                {
                    "id": f"local-{rel_path}",
                    "name": fname,
                    "relativePath": f"/{rel_path}",
                    "sizeBytes": stat.st_size,
                    "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                    "mtime": stat.st_mtime,
                    "status": "gesynchroniseerd",
                }
            )

    items.sort(key=lambda x: x["mtime"], reverse=True)
    for item in items[:limit]:
        item.pop("mtime", None)
    return items[:limit], total_count, total_bytes


def browse_directory(requested_rel_path: str) -> dict:
    base_real = _get_sync_root_real()
    target_real, clean_rel = resolve_safe_sync_path(requested_rel_path)

    if not os.path.isdir(base_real):
        return {
            "status": "ok",
            "root_label": HOST_SYNC_DIR_LABEL,
            "container_dir": LOCAL_SYNC_DIR,
            "current_path": "/",
            "parent_path": None,
            "exists": False,
            "entries": [],
            "total_files": 0,
            "total_bytes": 0,
        }

    if not os.path.isdir(target_real):
        raise FileNotFoundError(f"Map niet gevonden binnen {HOST_SYNC_DIR_LABEL}: {clean_rel}")

    entries: list[dict] = []
    with os.scandir(target_real) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_symlink():
                    continue
                entry_real = os.path.realpath(entry.path)
                if not entry_real.startswith(base_real + os.sep):
                    continue
                stat = entry.stat(follow_symlinks=False)
                mod_dt = datetime.datetime.fromtimestamp(stat.st_mtime).astimezone()
                rel_entry = "/" + os.path.relpath(entry_real, base_real).replace(os.sep, "/")

                if entry.is_dir(follow_symlinks=False):
                    sub_count = 0
                    try:
                        with os.scandir(entry_real) as sub_it:
                            sub_count = sum(1 for s in sub_it if not s.name.startswith(".") and not s.is_symlink())
                    except OSError:
                        sub_count = 0
                    entries.append(
                        {
                            "name": entry.name,
                            "path": rel_entry,
                            "type": "dir",
                            "sizeBytes": 0,
                            "itemCount": sub_count,
                            "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                        }
                    )
                elif entry.is_file(follow_symlinks=False):
                    entries.append(
                        {
                            "name": entry.name,
                            "path": rel_entry,
                            "type": "file",
                            "sizeBytes": stat.st_size,
                            "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                        }
                    )
            except OSError:
                continue

    entries.sort(key=lambda e: (0 if e["type"] == "dir" else 1, e["name"].lower()))

    if clean_rel == "/":
        parent_path = None
    else:
        parent_rel = clean_rel.rsplit("/", 1)[0]
        parent_path = parent_rel if parent_rel else "/"

    _, total_files, total_bytes = scan_local_files(limit=1)
    return {
        "status": "ok",
        "root_label": HOST_SYNC_DIR_LABEL,
        "container_dir": LOCAL_SYNC_DIR,
        "current_path": clean_rel,
        "parent_path": parent_path,
        "exists": True,
        "entries": entries,
        "total_files": total_files,
        "total_bytes": total_bytes,
    }


def get_state_snapshot(include_files: bool = True) -> dict:
    vault_present, vault_type, vault_updated_at = get_vault_info()
    with SYNC_LOCK:
        output_text = read_sync_log()
        payload = {
            "status": "ok",
            "version": APP_VERSION,
            "port": WEB_PORT,
            "vault_present": vault_present,
            "vault_type": vault_type,
            "vault_updated_at": vault_updated_at,
            "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "${defaultCron}"),
            "shared_folder": os.environ.get("O365_SHARED_FOLDER", "${config.sharedFolderPath}"),
            "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}"),
            "local_sync_dir": LOCAL_SYNC_DIR,
            "host_sync_dir": HOST_SYNC_DIR_LABEL,
            "running": SYNC_STATE["running"],
            "mode": SYNC_STATE["mode"],
            "command": SYNC_STATE["command"],
            "started_at": SYNC_STATE["started_at"],
            "finished_at": SYNC_STATE["finished_at"],
            "exit_code": SYNC_STATE["exit_code"],
            "output": output_text,
            "runs": list(SYNC_STATE["runs"]),
        }

    if include_files:
        files, total_files, total_bytes = scan_local_files()
        payload["files"] = files
        payload["total_files"] = total_files
        payload["total_bytes"] = total_bytes

    return payload


def _append_output(line: str) -> None:
    clean = line.rstrip("\\r\\n")
    with SYNC_LOCK:
        SYNC_STATE["output_lines"].append(clean)
        if len(SYNC_STATE["output_lines"]) > MAX_OUTPUT_LINES:
            SYNC_STATE["output_lines"] = SYNC_STATE["output_lines"][-MAX_OUTPUT_LINES:]


def _run_sync_worker(mode: str, flag: str) -> None:
    exit_code = -1
    timed_out = False
    proc: subprocess.Popen | None = None
    timer: threading.Timer | None = None
    before_size = os.path.getsize(SYNC_LOG_FILE) if os.path.isfile(SYNC_LOG_FILE) else 0

    def _on_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        if proc and proc.poll() is None:
            proc.kill()

    try:
        if not os.path.isfile(SYNC_SCRIPT):
            _append_output(f"[FOUT] Sync script niet gevonden op {SYNC_SCRIPT}")
            exit_code = 127
        else:
            proc = subprocess.Popen(
                [sys.executable, "-u", SYNC_SCRIPT, flag],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            timer = threading.Timer(SYNC_TIMEOUT_SECONDS, _on_timeout)
            timer.daemon = True
            timer.start()

            if proc.stdout is not None:
                for raw_line in proc.stdout:
                    _append_output(raw_line)
                proc.stdout.close()

            exit_code = proc.wait()
            if timed_out:
                _append_output(f"[FOUT] Sync afgebroken na timeout van {SYNC_TIMEOUT_SECONDS} seconden.")
                exit_code = 124
    except Exception as exc:
        _append_output(f"[FOUT] Kan sync.py niet uitvoeren: {exc}")
        exit_code = 1
    finally:
        if timer is not None:
            timer.cancel()

        after_size = os.path.getsize(SYNC_LOG_FILE) if os.path.isfile(SYNC_LOG_FILE) else 0
        if exit_code != 0 and after_size == before_size and SYNC_STATE["output_lines"]:
            try:
                with open(SYNC_LOG_FILE, "a", encoding="utf-8") as lf:
                    for line in SYNC_STATE["output_lines"]:
                        lf.write(line + "\\n")
            except OSError:
                pass

        finished_at = now_iso()
        with SYNC_LOCK:
            SYNC_STATE["running"] = False
            SYNC_STATE["finished_at"] = finished_at
            SYNC_STATE["exit_code"] = exit_code
            summary_line = ""
            for line in reversed(SYNC_STATE["output_lines"]):
                if line.strip():
                    summary_line = line.strip()
                    break
            SYNC_STATE["runs"].insert(
                0,
                {
                    "id": f"run-{int(datetime.datetime.now().timestamp() * 1000)}",
                    "mode": mode,
                    "command": SYNC_STATE["command"],
                    "started_at": SYNC_STATE["started_at"],
                    "finished_at": finished_at,
                    "exit_code": exit_code,
                    "summary": summary_line or ("Voltooid" if exit_code == 0 else "Mislukt"),
                },
            )
            SYNC_STATE["runs"] = SYNC_STATE["runs"][:MAX_RUN_HISTORY]


def start_sync_job(mode: str) -> tuple[bool, dict]:
    flag = ALLOWED_SYNC_MODES[mode]
    with SYNC_LOCK:
        if SYNC_STATE["running"]:
            started = False
        else:
            SYNC_STATE["running"] = True
            SYNC_STATE["mode"] = mode
            SYNC_STATE["command"] = f"python3 {SYNC_SCRIPT} {flag}"
            SYNC_STATE["started_at"] = now_iso()
            SYNC_STATE["finished_at"] = None
            SYNC_STATE["exit_code"] = None
            SYNC_STATE["output_lines"] = []
            started = True

    if started:
        worker = threading.Thread(target=_run_sync_worker, args=(mode, flag), daemon=True)
        worker.start()

    return started, get_state_snapshot(include_files=False)


def clear_logs() -> tuple[bool, dict]:
    with SYNC_LOCK:
        if SYNC_STATE["running"]:
            return False, {}
        SYNC_STATE["output_lines"] = []
        SYNC_STATE["runs"] = []
        SYNC_STATE["exit_code"] = None
        SYNC_STATE["command"] = None
        SYNC_STATE["mode"] = None
        SYNC_STATE["started_at"] = None
        SYNC_STATE["finished_at"] = None
        try:
            if os.path.isfile(SYNC_LOG_FILE):
                with open(SYNC_LOG_FILE, "w", encoding="utf-8"):
                    pass
        except OSError:
            pass
    return True, get_state_snapshot(include_files=True)


class SpaRequestHandler(SimpleHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_allowed_post_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urllib.parse.urlparse(origin)
        origin_host = parsed.netloc.lower()
        fwd_host = (self.headers.get("X-Forwarded-Host") or "").split(",")[0].strip().lower()
        allowed_hosts = {
            (self.headers.get("Host") or "").strip().lower(),
            fwd_host,
        }
        allowed_hosts.discard("")
        return origin_host in allowed_hosts

    def do_GET(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        clean_path = parsed_url.path
        query_params = urllib.parse.parse_qs(parsed_url.query)

        if clean_path == "/api/health":
            vault_present, vault_type, _ = get_vault_info()
            with SYNC_LOCK:
                sync_running = SYNC_STATE["running"]
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": APP_VERSION,
                    "port": WEB_PORT,
                    "vault_present": vault_present,
                    "vault_type": vault_type,
                    "sync_running": sync_running,
                    "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "${defaultCron}"),
                    "shared_folder": os.environ.get("O365_SHARED_FOLDER", "${config.sharedFolderPath}"),
                    "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "${config.ignoredFolders.join(',')}"),
                    "local_sync_dir": LOCAL_SYNC_DIR,
                    "host_sync_dir": HOST_SYNC_DIR_LABEL,
                },
            )
            return

        if clean_path == "/api/status":
            self._send_json(200, get_state_snapshot(include_files=True))
            return

        if clean_path == "/api/files":
            req_path = query_params.get("path", ["/"])[0]
            try:
                listing = browse_directory(req_path)
                self._send_json(200, listing)
            except PermissionError as exc:
                self._send_json(403, {"status": "error", "error": str(exc)})
            except FileNotFoundError as exc:
                self._send_json(404, {"status": "error", "error": str(exc)})
            return

        if clean_path == "/api/files/download":
            req_path = query_params.get("path", [""])[0]
            if not req_path:
                self._send_json(400, {"status": "error", "error": "Bestandspad ontbreekt"})
                return
            try:
                target_real, _ = resolve_safe_sync_path(req_path)
            except PermissionError as exc:
                self._send_json(403, {"status": "error", "error": str(exc)})
                return

            if not os.path.isfile(target_real) or os.path.islink(target_real):
                self._send_json(404, {"status": "error", "error": "Bestand niet gevonden"})
                return

            fname = os.path.basename(target_real)
            safe_ascii = re.sub(r'[^A-Za-z0-9._ -]', '_', fname)
            mime_type, _ = mimetypes.guess_type(target_real)
            try:
                file_size = os.path.getsize(target_real)
                with open(target_real, "rb") as f:
                    self.send_response(200)
                    self.send_header("Content-Type", mime_type or "application/octet-stream")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header(
                        "Content-Disposition",
                        f"attachment; filename=\\"{safe_ascii}\\"; filename*=UTF-8''{urllib.parse.quote(fname)}",
                    )
                    self.send_header("Content-Length", str(file_size))
                    self.end_headers()
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except OSError as exc:
                self._send_json(500, {"status": "error", "error": f"Kan bestand niet lezen: {exc}"})
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

    def do_POST(self) -> None:
        clean_path = self.path.split("?", 1)[0]

        if clean_path not in ("/api/sync", "/api/logs/clear"):
            self._send_json(404, {"status": "error", "error": "Onbekend endpoint"})
            return

        if not self._is_allowed_post_origin():
            self._send_json(403, {"status": "error", "error": "Niet-toegestane herkomst (Origin mismatch)"})
            return

        try:
            content_length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._send_json(400, {"status": "error", "error": "Ongeldige Content-Length header"})
            return

        if content_length < 0 or content_length > 4096:
            self._send_json(413, {"status": "error", "error": "Request body te groot"})
            return

        if clean_path == "/api/logs/clear":
            if content_length > 0:
                self.rfile.read(content_length)
            cleared, snapshot = clear_logs()
            if not cleared:
                self._send_json(
                    409,
                    {"status": "error", "error": "Kan log niet wissen zolang er een synchronisatie actief is."},
                )
                return
            snapshot["logs_cleared"] = True
            self._send_json(200, snapshot)
            return

        mode = "force"
        if content_length > 0:
            raw_body = self.rfile.read(content_length)
            try:
                body_json = json.loads(raw_body.decode("utf-8"))
                if isinstance(body_json, dict) and "mode" in body_json:
                    mode = str(body_json["mode"]).strip().lower()
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"status": "error", "error": "Ongeldige JSON payload"})
                return

        if mode not in ALLOWED_SYNC_MODES:
            self._send_json(
                400,
                {
                    "status": "error",
                    "error": f"Ongeldige sync-modus '{mode}'. Kies uit: {', '.join(sorted(ALLOWED_SYNC_MODES))}",
                },
            )
            return

        started, snapshot = start_sync_job(mode)
        if not started:
            snapshot["sync_status"] = "already_running"
            self._send_json(409, snapshot)
            return

        snapshot["sync_status"] = "started"
        self._send_json(202, snapshot)

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

cat << 'EOF_VERSION' > VERSION
v.01
EOF_VERSION

cat << 'EOF_WEB_SERVER' > web_server.py
${webServerPy.trimEnd()}
EOF_WEB_SERVER

chmod +x entrypoint.sh sync.py web_server.py

git add .github/workflows/docker-publish.yml VERSION Dockerfile docker-compose.yml entrypoint.sh sync.py web_server.py
git commit -m "Configureer O365 Okta Sync Docker build (amd64, poort 5555, auto-versioning) & GitHub Action"
git push

echo "Klaar! Open https://github.com/${config.githubRepo}/actions om de gestarte build te volgen."
`;
}

