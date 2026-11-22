#!/usr/bin/env bash
set -euo pipefail

CRON_SCHEDULE="${SYNC_CRON_SCHEDULE:-0 8-20/2 * * *}"
CRONTAB_FILE="/tmp/o365_sync_crontab"
RESOLVED_VERSION="${APP_VERSION:-$(cat /app/VERSION 2>/dev/null || echo v.01)}"

echo "=================================================================="
echo " O365 + Okta MFA Docker Sync Container Gestart (${RESOLVED_VERSION})"
echo " Tijdzone       : ${TZ:-Europe/Amsterdam}"
echo " Web UI Poort   : http://0.0.0.0:${WEB_PORT:-5555}"
echo " Cron Schema    : ${CRON_SCHEDULE} (Elke 2u tussen 08:00 en 20:00)"
echo " Gedeelde Map   : ${O365_SHARED_FOLDER:-/02. Callsheets}"
echo " Genegeerd      : ${O365_IGNORE_FOLDERS:-Callsheets Archief}"
echo " Container Doel : ${LOCAL_SYNC_DIR:-/data/sync}"
echo "=================================================================="

if [ ! -f "${COOKIE_VAULT_FILE:-/vault/sp_cookies.enc}" ] && [ ! -f "${TOKEN_VAULT_FILE:-/vault/token_cache.enc}" ]; then
  echo "[WAARSCHUWING] Nog geen versleutelde sessie gevonden in /vault."
  echo "[ACTIE VEREIST] Voer op de Docker host eenmalig het volgende uit (Username + Password + Okta MFA, zonder IT-goedkeuring):"
  echo "  docker exec -it oktasync python3 /app/sync.py --init-cookies"
fi

# Start webinterface op poort 5555 op de achtergrond
/usr/local/bin/python3 /app/web_server.py &

# Schrijf het 2-uurlijkse schema naar een tijdelijk crontab-bestand voor Supercronic
echo "${CRON_SCHEDULE} /usr/local/bin/python3 /app/sync.py" > "${CRONTAB_FILE}"

# Start Supercronic op de voorgrond (PID 1)
exec /usr/local/bin/supercronic "${CRONTAB_FILE}"
