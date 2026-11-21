export type AuthMethodId = 'oauth2-device-fernet' | 'sharepoint-cookie-vault' | 'rclone-docker-encrypted';

export interface SyncConfig {
  tenantDomain: string;
  sharepointSiteName: string;
  sharedFolderPath: string;
  ignoredFolders: string[];
  hostSyncVolumePath: string;
  hostVaultVolumePath: string;
  containerDataPath: string;
  containerVaultPath: string;
  oktaOrgUrl: string;
  usernameHint: string;
  clientId: string;
  authMethod: AuthMethodId;
  githubRepo: string;
  dockerImageName: string;
  timezone: string;
  startHour: number;
  endHour: number;
  intervalHours: number;
  weekdaysOnly: boolean;
  verifyChecksums: boolean;
  bandwidthLimitMbps: number;
}

export interface AuthStrategyInfo {
  id: AuthMethodId;
  title: string;
  subtitle: string;
  securityRating: string;
  recommended: boolean;
  mfaHandling: string;
  credentialStorage: string;
  summary: string;
  pros: string[];
  steps: string[];
}

export interface SyncFileItem {
  id: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  author: string;
  sha256: string;
  status: 'gesynchroniseerd' | 'nieuw' | 'gewijzigd' | 'overgeslagen';
  syncedAtSlot?: string;
}

export interface SyncRunLog {
  id: string;
  slotTime: string;
  executedAt: string;
  authModeUsed: string;
  tokenStatus: string;
  filesChecked: number;
  filesDownloaded: number;
  bytesTransferred: number;
  durationMs: number;
  status: 'voltooid' | 'overgeslagen' | 'waarschuwing';
  details: string;
}

export const AUTH_STRATEGIES: AuthStrategyInfo[] = [
  {
    id: 'sharepoint-cookie-vault',
    title: 'Directe SharePoint REST API via Okta Browser Sessie-Vault (FedAuth)',
    subtitle: '100% immuun voor AADSTS65001 én AADSTS65002 — gebruikt uw gewone Okta browsersessie zonder Entra App',
    securityRating: 'Hoog (Zero-OAuth / Geen Entra App)',
    recommended: true,
    mfaHandling: 'U logt in uw normale browser in op SharePoint via `nepglobal.okta.com` (Username + Password + Okta MFA) en slaat de `FedAuth` + `rtFa` sessiecookies eenmalig versleuteld op via `--init-cookies`.',
    credentialStorage: 'Versleutelde cookie-kluis (`sp_cookies.enc`) met Fernet AES-128 in `/opt/docker/callsheets-vault`.',
    summary: 'Zowel externe apps (`AADSTS65001`) als first-party apps zoals Microsoft Office (`AADSTS65002`) worden door Entra ID geblokkeerd voor Graph-scopes zonder IT-preauthorisatie. De SharePoint REST API (`_api/web/GetFolderByServerRelativePath`) werkt met uw normale Okta-browsersessie zonder enige Entra OAuth-app.',
    pros: [
      '100% immuun voor `AADSTS65001`, `AADSTS65002` en `AADSTS53003` — geen Entra App nodig',
      'Elke 2-uurlijkse sync (08:00–20:00) houdt de sliding SharePoint-sessie actief',
      'Gebruikt exact dezelfde rechten waarmee u `/02. Callsheets` in uw browser opent',
      'Volledige ondersteuning voor het recursief negeren van `Callsheets Archief`'
    ],
    steps: [
      'Open de SharePoint-map in Chrome/Edge en log in met Username + Password + Okta MFA.',
      'Voer eenmalig `docker exec -it oktasync python3 /app/sync.py --init-cookies` uit om `FedAuth` en `rtFa` versleuteld in `/vault` op te slaan.',
      'Controleer direct met `docker exec oktasync python3 /app/sync.py --verify` en start daarna automatisch elke 2 uur.'
    ]
  },
  {
    id: 'oauth2-device-fernet',
    title: 'Microsoft Graph CLI (14d82eec) + Fernet Token Kluis',
    subtitle: 'Alternatief via Microsoft Graph Command Line Tools (werkt alleen als User Consent in Entra aan staat)',
    securityRating: 'Hoog (Zero-Password Vault)',
    recommended: false,
    mfaHandling: 'Eenmalige `docker exec -it oktasync python3 /app/sync.py --init-auth` met Microsoft Graph CLI (`14d82eec-...`). U logt op uw eigen pc in met Username + Password + Okta MFA.',
    credentialStorage: 'MSAL TokenCache versleuteld met Fernet (AES-128-CBC + HMAC-SHA256) in `/opt/docker/callsheets-vault/token_cache.enc`.',
    summary: 'Gebruikt Microsofts officiële Graph CLI Client ID (`14d82eec-...`), die wél voor Microsoft Graph is gepreauthoriseerd (voorkomt `AADSTS65002`). Geeft uw tenant alsnog `AADSTS65001`? Schakel dan direct over naar Optie 1 (`--init-cookies`).',
    pros: [
      'Voorkomt `AADSTS65002` doordat `14d82eec-...` specifiek voor Microsoft Graph is geautoriseerd',
      'Volledig headless uitvoerbaar in uw lokale Docker container zonder wachtwoordopslag',
      'Stille Refresh Token vernieuwing elke 2 uur tussen 08:00 en 20:00 zonder nieuwe Okta MFA-prompt',
      'Automatische fallback-hint naar `--init-cookies` bij tenant-blokkades'
    ],
    steps: [
      'Gebruik Client ID `14d82eec-204b-4c2f-b7e8-296a70dab67e` (Microsoft Graph Command Line Tools).',
      'Bouw en start de container uit GitHub (`ckb-k28/oktasync`) via `docker compose up -d`.',
      'Voer eenmalig `docker exec -it oktasync python3 /app/sync.py --init-auth` uit en bevestig via `nepglobal.okta.com`.',
      'Controleer direct met `docker exec oktasync python3 /app/sync.py --verify` dat `Callsheets Archief` wordt genegeerd.'
    ]
  },
  {
    id: 'rclone-docker-encrypted',
    title: 'Rclone Headless Docker Container + Versleutelde Config',
    subtitle: 'Eenmalige Okta browser-autorisatie vanaf eigen laptop met versleutelde rclone.conf in Docker',
    securityRating: 'Hoog (AES-256 Config Encryptie)',
    recommended: false,
    mfaHandling: 'U voert eenmalig `rclone authorize "onedrive"` uit op een werkstation met browser (Username + Password + Okta MFA) en plaatst het versleutelde resultaat in `/opt/docker/callsheets-vault/rclone.conf`.',
    credentialStorage: 'AES-256 versleutelde `rclone.conf` gemount in `/vault`, ontsleuteld via `RCLONE_CONFIG_PASS`.',
    summary: 'Alternatief voor wie Rclone verkiest: autoriseer op een eigen werkstation in de browser via Okta en draai de container vervolgens headless met `--exclude "Callsheets Archief/**"`.',
    pros: [
      'Ingebouwde `--exclude "Callsheets Archief/**"` en QuickXorHash delta-controle',
      'Geen Device Code Flow op de server zelf nodig tijdens het inloggen',
      'Configuratiebestand op `/opt/docker/callsheets-vault` is AES-256 versleuteld'
    ],
    steps: [
      'Voer op uw laptop `rclone authorize "onedrive"` uit via `nepglobal.okta.com` + Okta MFA.',
      'Sla de versleutelde `rclone.conf` op in `/opt/docker/callsheets-vault`.',
      'De Docker container voert elke 2 uur (08:00–20:00) `rclone copy` uit naar `/opt/docker/callsheets`.'
    ]
  }
];

export const INITIAL_SYNC_FILES: SyncFileItem[] = [
  {
    id: 'f-101',
    name: 'Callsheet_Studio2_LiveShow_20261121.pdf',
    relativePath: '/02. Callsheets/Studio 2/Callsheet_Studio2_LiveShow_20261121.pdf',
    sizeBytes: 2429104,
    modifiedAt: '08:00',
    author: 'planning@nepworldwide.nl',
    sha256: '8f9d2a7c...e41b90',
    status: 'gesynchroniseerd',
    syncedAtSlot: '08:00'
  },
  {
    id: 'f-102',
    name: 'OBVan_UHD1_Eredivisie_Weekend.xlsx',
    relativePath: '/02. Callsheets/ENG & OB/OBVan_UHD1_Eredivisie_Weekend.xlsx',
    sizeBytes: 1284500,
    modifiedAt: '09:42',
    author: 'operations@nepworldwide.nl',
    sha256: '3c11b08e...77a21f',
    status: 'gesynchroniseerd',
    syncedAtSlot: '10:00'
  },
  {
    id: 'f-103',
    name: 'Crew_Rooster_Hilversum_Week47.csv',
    relativePath: '/02. Callsheets/Crew_Rooster_Hilversum_Week47.csv',
    sizeBytes: 642190,
    modifiedAt: '11:51',
    author: 'crewdesk@nepworldwide.nl',
    sha256: '9a44c12d...09e33b',
    status: 'gesynchroniseerd',
    syncedAtSlot: '12:00'
  },
  {
    id: 'f-104',
    name: 'Callsheet_Archief_2025_Q1_Bundel.pdf',
    relativePath: '/02. Callsheets/Callsheets Archief/Callsheet_Archief_2025_Q1_Bundel.pdf',
    sizeBytes: 18420900,
    modifiedAt: '08:15',
    author: 'archief@nepworldwide.nl',
    sha256: '5c81d44f...20a11e',
    status: 'overgeslagen'
  },
  {
    id: 'f-105',
    name: 'Callsheet_Studio4_Talkshow_Definitief.pdf',
    relativePath: '/02. Callsheets/Studio 4/Callsheet_Studio4_Talkshow_Definitief.pdf',
    sizeBytes: 3510200,
    modifiedAt: '13:35',
    author: 'productie@nepworldwide.nl',
    sha256: '4e88a31c...55d12a',
    status: 'nieuw'
  },
  {
    id: 'f-106',
    name: 'RF_Frequenties_Evenement_Zondag.json',
    relativePath: '/02. Callsheets/RF & Audio/RF_Frequenties_Evenement_Zondag.json',
    sizeBytes: 894120,
    modifiedAt: '13:52',
    author: 'rf.support@nepworldwide.nl',
    sha256: '1d77e40b...92f81c',
    status: 'gewijzigd'
  }
];

export const INITIAL_RUN_LOGS: SyncRunLog[] = [
  {
    id: 'run-0800',
    slotTime: '08:00',
    executedAt: 'Vandaag 08:00:02 (Container oktasync)',
    authModeUsed: 'Fernet AES-128 Vault (/vault/token_cache.enc)',
    tokenStatus: 'Access Token vernieuwd (silent Okta MFA)',
    filesChecked: 38,
    filesDownloaded: 2,
    bytesTransferred: 4821900,
    durationMs: 2410,
    status: 'voltooid',
    details: 'Supercronic trigger 08:00: 2 callsheets weggeschreven naar /opt/docker/callsheets. Map "Callsheets Archief" overgeslagen.'
  },
  {
    id: 'run-1000',
    slotTime: '10:00',
    executedAt: 'Vandaag 10:00:01 (Container oktasync)',
    authModeUsed: 'Fernet AES-128 Vault (/vault/token_cache.enc)',
    tokenStatus: 'Access Token vernieuwd (silent Okta MFA)',
    filesChecked: 39,
    filesDownloaded: 1,
    bytesTransferred: 1284500,
    durationMs: 1540,
    status: 'voltooid',
    details: 'Supercronic trigger 10:00: OBVan_UHD1_Eredivisie_Weekend.xlsx bijgewerkt in /opt/docker/callsheets/ENG & OB.'
  },
  {
    id: 'run-1200',
    slotTime: '12:00',
    executedAt: 'Vandaag 12:00:02 (Container oktasync)',
    authModeUsed: 'Fernet AES-128 Vault (/vault/token_cache.enc)',
    tokenStatus: 'Access Token vernieuwd (silent Okta MFA)',
    filesChecked: 39,
    filesDownloaded: 1,
    bytesTransferred: 642190,
    durationMs: 1380,
    status: 'voltooid',
    details: 'Supercronic trigger 12:00: Crew_Rooster_Hilversum_Week47.csv gedownload. Map "Callsheets Archief" genegeerd.'
  }
];
