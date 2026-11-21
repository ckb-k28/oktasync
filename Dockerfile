# ==============================================================================
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
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Europe/Amsterdam \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WEB_PORT=5555 \
    WEB_DIST_DIR=/app/dist

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Installeer Supercronic (linux/amd64)
ENV SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \
    SUPERCRONIC_SHA1SUM=cd48d45c4b10f3f0bfdd3a57d054cd05ac96812b

RUN curl -fsSL "${SUPERCRONIC_URL}" -o /usr/local/bin/supercronic \
    && echo "${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c - \
    && chmod +x /usr/local/bin/supercronic

# Maak onbevoegde container-gebruiker aan (UID 1000 zodat lokale volume-rechten kloppen)
RUN groupadd -g 1000 syncgroup && useradd -u 1000 -g syncgroup -m -s /bin/bash syncuser

WORKDIR /app

# Installeer Python dependencies (MSAL voor Okta/Entra OAuth2, Cryptography voor Fernet AES-128 kluis)
RUN pip install --no-cache-dir \
    msal==1.31.0 \
    cryptography==43.0.1 \
    requests==2.32.3

# Kopieer gebouwde webapplicatie en Python sync-bestanden
COPY --from=web-builder --chown=syncuser:syncgroup /web/dist /app/dist
COPY --chown=syncuser:syncgroup sync.py /app/sync.py
COPY --chown=syncuser:syncgroup web_server.py /app/web_server.py
COPY --chown=syncuser:syncgroup entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/sync.py /app/web_server.py /app/entrypoint.sh

# Maak mountpoints aan voor lokale doelmap (/data/sync) en versleutelde tokenkluis (/vault)
RUN mkdir -p /data/sync /vault \
    && chown -R syncuser:syncgroup /data/sync /vault /app

USER syncuser

EXPOSE 5555

VOLUME ["/data/sync", "/vault"]

ENTRYPOINT ["/app/entrypoint.sh"]
