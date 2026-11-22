# O365 Okta Sync

Automatische synchronisatie van een gedeelde SharePoint-map naar een lokale Docker-volume, inclusief versleutelde sessie-kluis, Supercronic-planning en een lichte webinterface op poort `5555`.

## Belangrijkste functies

- **Versleutelde sessie-kluis (`/vault`)**: Slaat sessiecookies (`sp_cookies.enc`) of tokens (`token_cache.enc`) AES-128 versleuteld op met Fernet.
- **Geplande & handmatige sync**: Draait automatisch via Supercronic (standaard elke 2 uur tussen `08:00` en `20:00`) en handmatig via de webinterface of CLI (`--force` / `--verify`).
- **Map-filter**: Slaat geconfigureerde submappen (zoals archiefmappen) automatisch over via `O365_IGNORE_FOLDERS`.
- **Live log & log wissen**: Toont elke synchronisatiestap realtime in de webinterface met ondersteuning om het log te legen.
- **Afgeschermde filebrowser**: Bladeren en downloaden blijft strikt beperkt tot de geconfigureerde data-map.
- **Automatische versienummering**: Verhoogt het versienummer (`v.01`, `v.02`, ...) automatisch bij elke build.

## Snel starten

### 1. Sleutel aanmaken
Genereer eenmalig een Fernet-sleutel en plaats deze in een `.env`-bestand naast `docker-compose.yml`:

```bash
python3 -c "from cryptography.fernet import Fernet; print('FERNET_VAULT_KEY=' + Fernet.generate_key().decode())" > .env
```

### 2. Container starten
Configureer uw eigen omgevingsvariabelen in `docker-compose.yml` en start de container:

```bash
docker compose up -d
```

### 3. Eenmalige sessie opslaan & testen
Sla de sessie op in `/vault`, controleer de verbinding en start desgewenst direct een synchronisatie:

```bash
# 1. Sessie opslaan
docker exec -it oktasync python3 /app/sync.py --init-cookies

# 2. Verbinding en rechten testen (zonder downloads)
docker exec oktasync python3 /app/sync.py --verify

# 3. Direct synchroniseren
docker exec oktasync python3 /app/sync.py --force
```

## Webinterface (`:5555`)

Open na het starten `http://<host-ip>:5555` in een browser voor:

- Direct starten van **Sync Nu (`--force`)** en **Test (`--verify`)**
- Realtime uitvoer bekijken en wissen (**Log wissen**)
- Bestanden bekijken en downloaden via de ingebouwde **Filebrowser**

## Volumes

| Doel | Host-map | Container-pad |
| :--- | :--- | :--- |
| Gesynchroniseerde bestanden | `/opt/docker/callsheets/data` | `/data/sync` |
| Versleutelde sessie-kluis | `/opt/docker/callsheets/vault` | `/vault` |

## Bijwerken

```bash
docker compose pull && docker compose up -d
```
