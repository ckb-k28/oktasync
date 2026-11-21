import React, { useState, useMemo } from 'react';
import {
  ShieldCheck,
  Clock,
  Terminal,
  Copy,
  Check,
  Download,
  Play,
  KeyRound,
  Lock,
  FileText,
  RefreshCw,
  Plus,
  Search,
  SlidersHorizontal,
  Container,
  FolderX,
  Trash2
} from 'lucide-react';
import {
  SyncConfig,
  AuthMethodId,
  AUTH_STRATEGIES,
  INITIAL_SYNC_FILES,
  INITIAL_RUN_LOGS,
  SyncFileItem,
  SyncRunLog
} from './types/syncConfig';
import {
  computeSyncTimeSlots,
  buildCronExpression,
  generateGithubWorkflowYaml,
  generateDockerfile,
  generateDockerComposeYaml,
  generateEntrypointScript,
  generateDockerPythonSyncScript
} from './utils/scriptGenerators';

type ActiveSection = 'overzicht' | 'authenticatie' | 'planning' | 'scripts' | 'simulatie';
type ScriptTab = 'dockerfile' | 'docker-compose' | 'github-workflow' | 'sync-py' | 'entrypoint';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('overzicht');
  const [scriptTab, setScriptTab] = useState<ScriptTab>('docker-compose');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [config, setConfig] = useState<SyncConfig>({
    tenantDomain: 'nepinc.sharepoint.com',
    sharepointSiteName: 'NEPNL-Operations',
    sharedFolderPath: '/02. Callsheets',
    ignoredFolders: ['Callsheets Archief'],
    hostSyncVolumePath: '/opt/docker/callsheets',
    hostVaultVolumePath: '/opt/docker/callsheets-vault',
    containerDataPath: '/data/sync',
    containerVaultPath: '/vault',
    oktaOrgUrl: 'https://nepglobal.okta.com',
    usernameHint: 'voornaam.achternaam@nepworldwide.nl',
    clientId: 'd3590ed6-52b3-4102-aeff-aad2292ab01c',
    authMethod: 'oauth2-device-fernet',
    githubRepo: 'ckb-k28/oktasync',
    dockerImageName: 'oktasync',
    timezone: 'Europe/Amsterdam',
    startHour: 8,
    endHour: 20,
    intervalHours: 2,
    weekdaysOnly: false,
    verifyChecksums: true,
    bandwidthLimitMbps: 25
  });

  const [newIgnoreFolder, setNewIgnoreFolder] = useState<string>('');

  // Interactive Headless Docker Device Code + Okta MFA Handshake State
  const [mfaStep, setMfaStep] = useState<1 | 2 | 3>(3);
  const [deviceCode, setDeviceCode] = useState<string>('DK9-4M7X2');
  const [totpCode, setTotpCode] = useState<string>('482910');
  const [tokenExpiryMinutes, setTokenExpiryMinutes] = useState<number>(58);
  const [tokenFingerprint, setTokenFingerprint] = useState<string>('FERNET::AES128-9F4A-77C1');

  // Simulation state
  const [files, setFiles] = useState<SyncFileItem[]>(INITIAL_SYNC_FILES);
  const [runLogs, setRunLogs] = useState<SyncRunLog[]>(INITIAL_RUN_LOGS);
  const [selectedSlot, setSelectedSlot] = useState<string>('14:00');
  const [fileSearch, setFileSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'alle' | 'gesynchroniseerd' | 'nieuw' | 'gewijzigd' | 'overgeslagen'>('alle');
  const [isSimulatingRun, setIsSimulatingRun] = useState<boolean>(false);

  const timeSlots = useMemo(
    () => computeSyncTimeSlots(config.startHour, config.endHour, config.intervalHours),
    [config.startHour, config.endHour, config.intervalHours]
  );

  const cronExpression = useMemo(
    () => buildCronExpression(config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly),
    [config.startHour, config.endHour, config.intervalHours, config.weekdaysOnly]
  );

  const selectedStrategy = useMemo(
    () => AUTH_STRATEGIES.find((s) => s.id === config.authMethod) || AUTH_STRATEGIES[0],
    [config.authMethod]
  );

  const generatedScripts = useMemo(() => {
    return {
      'docker-compose': {
        filename: 'docker-compose.yml',
        label: 'Lokale Docker Host configuratie met Volume Mounts & Fernet Key',
        content: generateDockerComposeYaml(config)
      },
      'dockerfile': {
        filename: 'Dockerfile',
        label: 'Non-root Python 3.12 + Supercronic Container Image',
        content: generateDockerfile(config)
      },
      'github-workflow': {
        filename: '.github/workflows/docker-publish.yml',
        label: 'GitHub Actions Multi-Arch Build & Push naar GHCR',
        content: generateGithubWorkflowYaml(config)
      },
      'sync-py': {
        filename: 'sync.py',
        label: 'Python MSAL Device Code + Fernet AES-128 Token Vault Script',
        content: generateDockerPythonSyncScript(config)
      },
      'entrypoint': {
        filename: 'entrypoint.sh',
        label: 'Container Entrypoint & Supercronic 08:00–20:00 Crontab',
        content: generateEntrypointScript(config)
      }
    };
  }, [config]);

  const filteredFiles = useMemo(() => {
    return files.filter((file) => {
      const matchesSearch =
        file.name.toLowerCase().includes(fileSearch.toLowerCase()) ||
        file.relativePath.toLowerCase().includes(fileSearch.toLowerCase()) ||
        file.author.toLowerCase().includes(fileSearch.toLowerCase());
      const matchesStatus = statusFilter === 'alle' || file.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [files, fileSearch, statusFilter]);

  const pendingFilesCount = useMemo(
    () => files.filter((f) => f.status === 'nieuw' || f.status === 'gewijzigd').length,
    [files]
  );

  const handleCopyCode = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleDownloadScript = (filename: string, content: string) => {
    const cleanName = filename.split('/').pop() || filename;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = cleanName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleStartDeviceBootstrap = () => {
    const randomChars = Math.random().toString(36).substring(2, 7).toUpperCase();
    setDeviceCode(`DK9-${randomChars}`);
    setMfaStep(1);
  };

  const handleCompleteMfaBootstrap = () => {
    const randomHex = Math.floor(1000 + Math.random() * 9000).toString(16).toUpperCase();
    setTokenFingerprint(`FERNET::AES128-9F4A-${randomHex}`);
    setTokenExpiryMinutes(60);
    setMfaStep(3);
  };

  const isFileInIgnoredFolder = (relativePath: string, ignored: string[]) => {
    const segments = relativePath
      .split('/')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return ignored.some((folder) => segments.includes(folder.trim().toLowerCase()));
  };

  const handleAddIgnoreFolder = () => {
    const trimmed = newIgnoreFolder.trim();
    if (!trimmed) return;
    if (!config.ignoredFolders.some((f) => f.toLowerCase() === trimmed.toLowerCase())) {
      setConfig({ ...config, ignoredFolders: [...config.ignoredFolders, trimmed] });
    }
    setNewIgnoreFolder('');
  };

  const handleRemoveIgnoreFolder = (folderToRemove: string) => {
    setConfig({
      ...config,
      ignoredFolders: config.ignoredFolders.filter((f) => f !== folderToRemove)
    });
  };

  const handleTriggerSyncSlot = (slotTime: string) => {
    setIsSimulatingRun(true);
    setSelectedSlot(slotTime);

    setTimeout(() => {
      let downloadedCount = 0;
      let ignoredCount = 0;
      let transferredBytes = 0;

      const updatedFiles = files.map((file) => {
        if (isFileInIgnoredFolder(file.relativePath, config.ignoredFolders)) {
          ignoredCount += 1;
          return {
            ...file,
            status: 'overgeslagen' as const
          };
        }
        if (file.status === 'nieuw' || file.status === 'gewijzigd') {
          downloadedCount += 1;
          transferredBytes += file.sizeBytes;
          return {
            ...file,
            status: 'gesynchroniseerd' as const,
            syncedAtSlot: slotTime
          };
        }
        return file;
      });

      setFiles(updatedFiles);
      setTokenExpiryMinutes(60);

      const ignoredNote =
        config.ignoredFolders.length > 0
          ? ` Genegeerde mappen overgeslagen: ${config.ignoredFolders.join(', ')} (${ignoredCount} bestand).`
          : '';

      const newLog: SyncRunLog = {
        id: `run-${Date.now()}`,
        slotTime,
        executedAt: `Vandaag ${slotTime}:02 (Container ${config.dockerImageName})`,
        authModeUsed: `Fernet AES-128 Vault (${config.containerVaultPath}/token_cache.enc)`,
        tokenStatus: 'Access Token vernieuwd via Okta Refresh Token (geldig 60m)',
        filesChecked: updatedFiles.length + 34,
        filesDownloaded: downloadedCount,
        bytesTransferred: transferredBytes,
        durationMs: downloadedCount > 0 ? 1320 + downloadedCount * 380 : 620,
        status: 'voltooid',
        details:
          downloadedCount > 0
            ? `Supercronic trigger ${slotTime}: ${downloadedCount} bestand(en) gedownload naar ${config.hostSyncVolumePath}.${ignoredNote}`
            : `Supercronic trigger ${slotTime}: Geen gewijzigde bestanden op O365 gedeelde map sinds vorige run.${ignoredNote}`
      };

      setRunLogs((prev) => [newLog, ...prev]);
      setIsSimulatingRun(false);
    }, 350);
  };

  const handleAddSimulatedRemoteFile = () => {
    const index = files.length + 1;
    const nowTime = new Date().toTimeString().slice(0, 5);
    const sampleItems = [
      {
        name: `Callsheet_Studio1_Live_${index}.pdf`,
        folder: 'Studio 1',
        ignored: false
      },
      {
        name: `Callsheet_OBVan_Sport_${index}.xlsx`,
        folder: 'ENG & OB',
        ignored: false
      },
      {
        name: `Callsheet_Oud_Archief_${index}.pdf`,
        folder: config.ignoredFolders[0] || 'Callsheets Archief',
        ignored: config.ignoredFolders.length > 0
      },
      {
        name: `Crew_Schema_Hilversum_${index}.csv`,
        folder: 'Crew Planning',
        ignored: false
      }
    ];
    const picked = sampleItems[index % sampleItems.length];
    const newFile: SyncFileItem = {
      id: `f-${Date.now()}`,
      name: picked.name,
      relativePath: `${config.sharedFolderPath}/${picked.folder}/${picked.name}`,
      sizeBytes: 940200 + (index * 315400) % 3200000,
      modifiedAt: nowTime,
      author: config.usernameHint,
      sha256: `${Math.random().toString(16).slice(2, 10)}...${Math.random().toString(16).slice(2, 8)}`,
      status: picked.ignored ? 'overgeslagen' : 'nieuw'
    };
    setFiles((prev) => [newFile, ...prev]);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Top Bar Contract: Zone 1 (Wordmark) - Zone 2 (4-5 Nav Links) - Zone 3 (1 Primary CTA) */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white border-b border-slate-200 sticky top-0 z-30">
        <a
          href="#overzicht"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('overzicht');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          O365 Okta Sync Studio
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a
            href="#overzicht"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('overzicht');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeSection === 'overzicht' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent'
            }`}
          >
            Docker Overzicht
          </a>
          <a
            href="#authenticatie"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('authenticatie');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeSection === 'authenticatie' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent'
            }`}
          >
            Okta MFA in Docker
          </a>
          <a
            href="#planning"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('planning');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeSection === 'planning' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent'
            }`}
          >
            Tijdschema (08:00–20:00)
          </a>
          <a
            href="#scripts"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('scripts');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeSection === 'scripts' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent'
            }`}
          >
            Docker & GitHub Build
          </a>
          <a
            href="#simulatie"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('simulatie');
            }}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 py-1 border-b-2 ${
              activeSection === 'simulatie' ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent'
            }`}
          >
            Sync Simulator
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() =>
              handleDownloadScript(
                generatedScripts[scriptTab].filename,
                generatedScripts[scriptTab].content
              )
            }
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download {generatedScripts[scriptTab].filename.split('/').pop()}
          </button>
        </div>
      </header>

      {/* Main Workspace Layout: Left Configuration Sidebar + Main Content Viewport */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 px-6 py-8">
        {/* Left Column: Live Docker + GitHub + O365 Configuration Parameters */}
        <aside className="lg:col-span-4 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">Docker & GitHub Parameters</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configureer uw GitHub repository, lokale Docker volume mounts en O365/Okta gegevens.
                </p>
              </div>
              <SlidersHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Headless Container Authenticatie (Okta MFA)
                </label>
                <select
                  value={config.authMethod}
                  onChange={(e) =>
                    setConfig({ ...config, authMethod: e.target.value as AuthMethodId })
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="oauth2-device-fernet">
                    1. Microsoft First-Party Client + Fernet Kluis (Zonder IT-goedkeuring)
                  </option>
                  <option value="sharepoint-cookie-vault">
                    2. Directe SharePoint REST API + Okta Cookie Kluis (100% AADSTS65001-vrij)
                  </option>
                  <option value="rclone-docker-encrypted">
                    3. Rclone Container + AES-256 Versleutelde Config
                  </option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    GitHub Repository
                  </label>
                  <input
                    type="text"
                    value={config.githubRepo}
                    onChange={(e) => setConfig({ ...config, githubRepo: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Container Naam
                  </label>
                  <input
                    type="text"
                    value={config.dockerImageName}
                    onChange={(e) => setConfig({ ...config, dockerImageName: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    O365 Tenant Domein
                  </label>
                  <input
                    type="text"
                    value={config.tenantDomain}
                    onChange={(e) => setConfig({ ...config, tenantDomain: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SharePoint Site Naam
                  </label>
                  <input
                    type="text"
                    value={config.sharepointSiteName}
                    onChange={(e) => setConfig({ ...config, sharepointSiteName: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Gedeelde O365 Map Pad (Bron in Shared Documents)
                </label>
                <input
                  type="text"
                  value={config.sharedFolderPath}
                  onChange={(e) => setConfig({ ...config, sharedFolderPath: e.target.value })}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Genegeerde SharePoint Submappen (Ignore List)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Bijv. Callsheets Archief"
                    value={newIgnoreFolder}
                    onChange={(e) => setNewIgnoreFolder(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddIgnoreFolder();
                      }
                    }}
                    className="flex-1 px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                  <button
                    type="button"
                    onClick={handleAddIgnoreFolder}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Toevoegen
                  </button>
                </div>
                {config.ignoredFolders.length > 0 && (
                  <div className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg bg-slate-50">
                    {config.ignoredFolders.map((folder) => (
                      <div
                        key={folder}
                        className="flex items-center justify-between px-3 py-1.5 text-xs"
                      >
                        <span className="font-mono text-slate-800 flex items-center gap-1.5 truncate">
                          <FolderX className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          {folder}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveIgnoreFolder(folder)}
                          aria-label={`Verwijder ${folder} uit negeerlijst`}
                          className="text-slate-400 hover:text-red-600 transition-colors p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Host Doelmap (Docker Volume)
                  </label>
                  <input
                    type="text"
                    value={config.hostSyncVolumePath}
                    onChange={(e) => setConfig({ ...config, hostSyncVolumePath: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Host Token Kluis Pad
                  </label>
                  <input
                    type="text"
                    value={config.hostVaultVolumePath}
                    onChange={(e) => setConfig({ ...config, hostVaultVolumePath: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Okta Federatie URL
                  </label>
                  <input
                    type="text"
                    value={config.oktaOrgUrl}
                    onChange={(e) => setConfig({ ...config, oktaOrgUrl: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    O365 / Okta Gebruikersnaam
                  </label>
                  <input
                    type="text"
                    value={config.usernameHint}
                    onChange={(e) => setConfig({ ...config, usernameHint: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Microsoft First-Party Client ID (Zonder IT Admin Consent)
                </label>
                <select
                  value={config.clientId}
                  onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="d3590ed6-52b3-4102-aeff-aad2292ab01c">
                    d3590ed6-52b3-4102-aeff-aad2292ab01c (Microsoft Office — pre-consented)
                  </option>
                  <option value="9bc3ab49-b65d-410a-85ad-bf819febf99b">
                    9bc3ab49-b65d-410a-85ad-bf819febf99b (SharePoint Online Client)
                  </option>
                  <option value="04b07795-8ddb-461a-bbee-02f9e1bf7b46">
                    04b07795-8ddb-461a-bbee-02f9e1bf7b46 (Microsoft Azure CLI)
                  </option>
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Geen PnP of eigen Entra App nodig. Als deze toch geblokkeerd zijn, kies dan bovenin <strong>Optie 2 (SharePoint Cookie Kluis)</strong>.
                </p>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Tijdsvenster in Container ({config.timezone}: 08:00 – 20:00, elke 2 uur)
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-1">Startuur</span>
                    <input
                      type="number"
                      min={0}
                      max={22}
                      value={config.startHour}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          startHour: Math.min(Number(e.target.value), config.endHour - 1)
                        })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-1">Einduur</span>
                    <input
                      type="number"
                      min={1}
                      max={23}
                      value={config.endHour}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          endHour: Math.max(Number(e.target.value), config.startHour + 1)
                        })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-1">Interval (uur)</span>
                    <select
                      value={config.intervalHours}
                      onChange={(e) =>
                        setConfig({ ...config, intervalHours: Number(e.target.value) })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <option value={1}>Elke 1u</option>
                      <option value={2}>Elke 2u</option>
                      <option value={3}>Elke 3u</option>
                      <option value={4}>Elke 4u</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <label className="text-xs text-slate-700 font-medium flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.weekdaysOnly}
                    onChange={(e) => setConfig({ ...config, weekdaysOnly: e.target.checked })}
                    className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  Alleen op werkdagen (Ma–Vr)
                </label>
                <span className="text-xs font-mono text-slate-500 tabular-nums">
                  {timeSlots.length} runs / dag
                </span>
              </div>
            </div>
          </div>

          {/* Headless Docker Security Explanation Box */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-slate-900 font-semibold text-sm">
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
              Hoe werkt Okta MFA in een headless Docker container?
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Een Docker container heeft geen browservenster voor Okta MFA en er mogen <strong>nooit wachtwoorden of tokens in de GitHub build</strong> staan.
            </p>
            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-1.5">
              <div>
                <strong className="text-slate-800">1. GitHub Actions Build:</strong> Bouwt een schone image (<code className="font-mono">ghcr.io/{config.githubRepo.toLowerCase()}</code>) met Python + MSAL + Supercronic zonder credentials.
              </div>
              <div>
                <strong className="text-slate-800">2. Device Code Bootstrap:</strong> Voer op uw lokale Docker host eenmalig <code className="font-mono">docker exec -it {config.dockerImageName} python3 /app/sync.py --init-auth</code> uit en log op uw eigen pc/telefoon in met Username + Password + Okta MFA.
              </div>
              <div>
                <strong className="text-slate-800">3. Fernet AES-128 Kluis:</strong> Het Refresh Token wordt versleuteld opgeslagen in <code className="font-mono">{config.hostVaultVolumePath}</code> en elke 2 uur (08:00–20:00) stilzwijgend ververst.
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column: Main Interactive Workspace */}
        <main className="lg:col-span-8 space-y-8">
          {/* Top Summary Metrics Strip */}
          <section id="overzicht" className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-100">
              <div>
                <div className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                  <span>GitHub Build</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">ghcr.io/{config.githubRepo.toLowerCase()}</span>
                  <span aria-hidden="true">·</span>
                  <span>Lokale Docker Host ({config.hostSyncVolumePath})</span>
                </div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight mt-1 text-balance">
                  Docker & GitHub CI/CD: 2-Uurlijkse O365 Sync ({String(config.startHour).padStart(2, '0')}:00 – {String(config.endHour).padStart(2, '0')}:00)
                </h1>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleTriggerSyncSlot(selectedSlot)}
                  disabled={isSimulatingRun}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  {isSimulatingRun ? 'Container Sync...' : `Test Container Run (${selectedSlot})`}
                </button>
              </div>
            </div>

            {/* 4-Column Metric Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pt-6">
              <div>
                <div className="text-xs text-slate-500">Supercronic Tijdslots</div>
                <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                  {timeSlots.length} runs / dag
                </div>
                <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                  {timeSlots[0]} t/m {timeSlots[timeSlots.length - 1]} ({config.timezone})
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Container Cron Expressie</div>
                <div className="text-base font-bold font-mono tabular-nums text-slate-900 mt-1.5">
                  {cronExpression}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Non-root UID 1000 runner
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Docker Volume Token Kluis</div>
                <div className="text-base font-bold text-emerald-700 mt-1.5 flex items-center gap-1.5">
                  <Lock className="w-4 h-4 shrink-0" />
                  Fernet AES-128
                </div>
                <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                  {config.containerVaultPath}/token_cache.enc
                </div>
              </div>

              <div>
                <div className="text-xs text-slate-500">Wachtrij Gedeelde Map</div>
                <div className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                  {pendingFilesCount} {pendingFilesCount === 1 ? 'bestand' : 'bestanden'}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Bind-mount: <span className="font-mono">{config.containerDataPath}</span>
                </div>
              </div>
            </div>
          </section>

          {/* Ready-to-Use GitHub Build & Docker Config Generator Section */}
          <section id="scripts" className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  01. GitHub Repository & Lokale Docker Host Bestanden (linux/amd64)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Belangrijk voor GitHub Actions: plaats <code className="font-mono text-slate-800">.github/workflows/docker-publish.yml</code> exact in de verborgen map <code className="font-mono text-slate-800">.github/workflows/</code> (met punt ervoor) en de overige bestanden in de root van <code className="font-mono text-slate-800">{config.githubRepo}</code>.
                </p>
              </div>

              {/* Script Selector Tabs */}
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                <button
                  onClick={() => setScriptTab('docker-compose')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    scriptTab === 'docker-compose'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  docker-compose.yml
                </button>
                <button
                  onClick={() => setScriptTab('dockerfile')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    scriptTab === 'dockerfile'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Dockerfile
                </button>
                <button
                  onClick={() => setScriptTab('github-workflow')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    scriptTab === 'github-workflow'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  GitHub Action (.yml)
                </button>
                <button
                  onClick={() => setScriptTab('sync-py')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    scriptTab === 'sync-py'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  sync.py
                </button>
                <button
                  onClick={() => setScriptTab('entrypoint')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    scriptTab === 'entrypoint'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  entrypoint.sh
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between bg-slate-900 text-slate-200 px-4 py-2.5 rounded-t-lg border-b border-slate-800">
                <div className="flex items-center gap-2 text-xs font-mono">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{generatedScripts[scriptTab].filename}</span>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-slate-400 font-sans">{generatedScripts[scriptTab].label}</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      handleCopyCode(scriptTab, generatedScripts[scriptTab].content)
                    }
                    className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedId === scriptTab ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Gekopieerd
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Kopieer Code
                      </>
                    )}
                  </button>
                  <button
                    onClick={() =>
                      handleDownloadScript(
                        generatedScripts[scriptTab].filename,
                        generatedScripts[scriptTab].content
                      )
                    }
                    className="px-2.5 py-1 text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </div>
              </div>

              <pre className="bg-slate-950 text-slate-100 p-4 rounded-b-lg text-xs font-mono overflow-x-auto max-h-[420px] leading-relaxed -mt-3">
                <code>{generatedScripts[scriptTab].content}</code>
              </pre>
            </div>
          </section>

          {/* Okta MFA + Headless Docker Authentication Architecture & Interactive Device Code Simulator */}
          <section id="authenticatie" className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  02. Headless Docker Authenticatie: Username + Password + Okta MFA
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Hoe de lokaal gehoste container authenticeert zonder browser of opgeslagen wachtwoorden.
                </p>
              </div>
              {/* Segmented Filter Control for Auth Strategy */}
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
                {AUTH_STRATEGIES.map((strategy, idx) => (
                  <button
                    key={strategy.id}
                    onClick={() => setConfig({ ...config, authMethod: strategy.id })}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      config.authMethod === strategy.id
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Optie {idx + 1}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* Left 7 Cols: Selected Strategy Details */}
              <div className="md:col-span-7 space-y-4">
                <div>
                  <div className="text-xs text-emerald-700 font-semibold">
                    {selectedStrategy.securityRating} · {selectedStrategy.recommended ? 'Aanbevolen voor Lokale Docker Host' : 'Alternatieve Docker Architectuur'}
                  </div>
                  <h3 className="text-base font-bold text-slate-900 mt-1">
                    {selectedStrategy.title}
                  </h3>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                    {selectedStrategy.summary}
                  </p>
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-100 text-xs">
                  <div>
                    <span className="font-semibold text-slate-800">Okta MFA afhandeling in Docker: </span>
                    <span className="text-slate-600">{selectedStrategy.mfaHandling}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-800">Persistente Container Kluis: </span>
                    <span className="text-slate-600">{selectedStrategy.credentialStorage}</span>
                  </div>
                </div>

                <div className="pt-2">
                  <div className="text-xs font-semibold text-slate-800 mb-2">
                    Implementatiestappen (GitHub naar Lokale Docker):
                  </div>
                  <ol className="space-y-2 text-xs text-slate-600">
                    {selectedStrategy.steps.map((step, index) => (
                      <li key={index} className="flex items-start gap-2.5">
                        <span className="font-mono font-bold text-slate-900 tabular-nums shrink-0">
                          0{index + 1}.
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              {/* Right 5 Cols: Interactive Docker Exec Device Code + Okta MFA Simulator */}
              <div className="md:col-span-5 bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col justify-between space-y-4">
                <div>
                  <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <Container className="w-3.5 h-3.5 text-slate-700" />
                      Docker Exec MFA Bootstrap
                    </span>
                    <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                      Stap {mfaStep}/3
                    </span>
                  </div>

                  {mfaStep === 1 && (
                    <div className="space-y-3 pt-3">
                      <p className="text-xs text-slate-600">
                        <strong>Stap 1 (Container CLI):</strong> Na <code className="font-mono">docker exec -it {config.dockerImageName} python3 /app/sync.py --init-auth</code> toont de container deze OAuth2 Device Code:
                      </p>
                      <div className="space-y-1.5 bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px]">
                        <div className="text-slate-400">Open: https://microsoft.com/devicelogin</div>
                        <div className="text-emerald-400 font-bold">Code: {deviceCode}</div>
                        <div className="text-slate-300">User: {config.usernameHint}</div>
                      </div>
                      <button
                        onClick={() => setMfaStep(2)}
                        className="w-full py-2 px-3 bg-slate-900 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
                      >
                        Voer Username + Wachtwoord in & Doorsturen naar Okta
                      </button>
                    </div>
                  )}

                  {mfaStep === 2 && (
                    <div className="space-y-3 pt-3">
                      <p className="text-xs text-slate-600">
                        <strong>Stap 2 (Okta MFA Verificatie):</strong> Na uw wachtwoord vraagt <code className="font-mono">{config.oktaOrgUrl}</code> om uw tweede factor (Okta Verify Push of TOTP).
                      </p>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Okta 6-cijferige MFA Code
                        </label>
                        <input
                          type="text"
                          maxLength={6}
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums tracking-widest bg-white border border-slate-300 rounded-lg"
                        />
                      </div>
                      <button
                        onClick={handleCompleteMfaBootstrap}
                        className="w-full py-2 px-3 bg-emerald-700 text-white text-xs font-semibold rounded-lg hover:bg-emerald-800 transition-colors cursor-pointer"
                      >
                        Bevestig Okta MFA & Schrijf naar /vault
                      </button>
                    </div>
                  )}

                  {mfaStep === 3 && (
                    <div className="space-y-3 pt-3">
                      <div className="text-xs text-emerald-800 font-semibold flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                        Fernet Token Kluis Actief in Docker Volume
                      </div>
                      <div className="text-[11px] font-mono bg-white border border-slate-200 rounded p-2.5 space-y-1 text-slate-700">
                        <div>Kluis: {config.containerVaultPath}/token_cache.enc</div>
                        <div>Sleutel: {tokenFingerprint}</div>
                        <div>Host pad: {config.hostVaultVolumePath}</div>
                        <div>Status: Gereed voor {timeSlots.length} dagelijkse cron-runs</div>
                      </div>
                      <button
                        onClick={handleStartDeviceBootstrap}
                        className="w-full py-1.5 px-3 bg-white border border-slate-300 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        Simuleer `docker exec --init-auth` Handshake
                      </button>
                    </div>
                  )}
                </div>

                <div className="text-[11px] text-slate-500 border-t border-slate-200 pt-2.5">
                  Zelfs als de container opnieuw wordt opgestart of geüpdatet vanuit GitHub Actions, blijft <code className="font-mono">token_cache.enc</code> bewaard op uw host-volume.
                </div>
              </div>
            </div>
          </section>

          {/* Visual 08:00 - 20:00 Schedule Timeline */}
          <section id="planning" className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  03. Dagelijks Supercronic Schema ({String(config.startHour).padStart(2, '0')}:00 tot {String(config.endHour).padStart(2, '0')}:00)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Klik op een tijdslot om een container-synchronisatie op dat tijdstip te simuleren. Buiten dit venster (20:01–07:59) voert de container geen netwerkcalls uit.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500 tabular-nums shrink-0">
                Vensterduur: {config.endHour - config.startHour} uur · Stap: {config.intervalHours} uur
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2.5">
              {timeSlots.map((slot) => {
                const completedLog = runLogs.find((l) => l.slotTime === slot);
                const isSelected = selectedSlot === slot;
                return (
                  <button
                    key={slot}
                    onClick={() => handleTriggerSyncSlot(slot)}
                    className={`p-3 rounded-lg border text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : completedLog
                        ? 'border-emerald-200 bg-emerald-50/50 text-slate-900 hover:border-emerald-400'
                        : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold font-mono tabular-nums">{slot}</span>
                      <Clock className={`w-3.5 h-3.5 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`} />
                    </div>
                    <div
                      className={`text-[11px] mt-1.5 font-medium ${
                        isSelected
                          ? 'text-slate-200'
                          : completedLog
                          ? 'text-emerald-700'
                          : 'text-slate-500'
                      }`}
                    >
                      {completedLog ? 'Voltooid' : 'Gepland'}
                    </div>
                    <div
                      className={`text-[10px] font-mono tabular-nums mt-0.5 ${
                        isSelected ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {completedLog ? `${completedLog.filesDownloaded} nieuw` : 'Silent Token'}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Live File Synchronization & Audit Log Simulator */}
          <section id="simulatie" className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  04. Gedeelde O365 Map naar Docker Bind-Mount ({config.hostSyncVolumePath})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Voeg een testbestand toe aan de gedeelde Office 365 map en voer een 2-uurlijkse container-run uit om de delta-synchronisatie naar uw lokale host-volume te testen.
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleAddSimulatedRemoteFile}
                  className="px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Simuleer Nieuw O365 Bestand
                </button>
                <button
                  onClick={() => handleTriggerSyncSlot(selectedSlot)}
                  className="px-3.5 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSimulatingRun ? 'animate-spin' : ''}`} />
                  Synchroniseer Nu ({pendingFilesCount} wachtend)
                </button>
              </div>
            </div>

            {/* Filter & Search Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-sm">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filter op bestandsnaam, map of auteur..."
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start overflow-x-auto">
                {(['alle', 'nieuw', 'gewijzigd', 'gesynchroniseerd', 'overgeslagen'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize whitespace-nowrap shrink-0 cursor-pointer ${
                      statusFilter === st
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            {/* High-Density Data Grid */}
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Bestandsnaam & SharePoint Pad</th>
                    <th className="py-2.5 px-3">Auteur (O365)</th>
                    <th className="py-2.5 px-3 text-right">Grootte</th>
                    <th className="py-2.5 px-3 text-right">Gewijzigd</th>
                    <th className="py-2.5 px-3">Status & Doelpad</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {filteredFiles.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-500">
                        Geen bestanden gevonden voor dit filter. Klik op &ldquo;Simuleer Nieuw O365 Bestand&rdquo; om een item toe te voegen.
                      </td>
                    </tr>
                  ) : (
                    filteredFiles.map((file) => (
                      <tr key={file.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>{file.name}</span>
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                            {file.relativePath} · SHA256: {file.sha256}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-600 font-mono text-[11px]">
                          {file.author}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                          {file.modifiedAt}
                        </td>
                        <td className="py-2.5 px-3">
                          {file.status === 'gesynchroniseerd' && (
                            <span className="text-emerald-700 font-medium">
                              Op Host Volume · <span className="font-mono tabular-nums">{file.syncedAtSlot}</span>
                            </span>
                          )}
                          {file.status === 'nieuw' && (
                            <span className="text-amber-700 font-semibold">
                              Wacht op eerstvolgende 2u-sync
                            </span>
                          )}
                          {file.status === 'gewijzigd' && (
                            <span className="text-amber-700 font-semibold">
                              Delta gewijzigd op O365
                            </span>
                          )}
                          {file.status === 'overgeslagen' && (
                            <span className="text-slate-500 font-medium">
                              Genegeerd (Ignore-map)
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Execution Audit Log */}
            <div className="pt-2 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">
                  Docker Container Synchronisatie Logs (Supercronic stdout)
                </h3>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  Laatste {runLogs.length} runs
                </span>
              </div>

              <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/50">
                {runLogs.map((log) => (
                  <div key={log.id} className="p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 text-slate-900 font-semibold flex-wrap">
                        <span className="font-mono tabular-nums">Slot {log.slotTime}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span>{log.authModeUsed}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className="text-emerald-700">{log.tokenStatus}</span>
                      </div>
                      <p className="text-slate-600">{log.details}</p>
                    </div>
                    <div className="text-right font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                      <div>{log.filesDownloaded} gedownload / {log.filesChecked} gecheckt</div>
                      <div>{formatBytes(log.bytesTransferred)} · {log.durationMs} ms</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Section 05: Preflight Verification & Enterprise Okta/Entra Risk Matrix */}
          <section id="verificatie" className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div className="border-b border-slate-100 pb-4">
              <h2 className="text-lg font-bold text-slate-900">
                05. Verbinding Verifiëren & Okta / Entra ID Risico-check
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Deze web-app is een generator en draait zelf geen Docker of Okta-sessie. Gebruik deze 3 testcommando&rsquo;s op uw lokale Docker host om 100% zeker te weten dat de verbinding werkt vóórdat de 2-uurlijkse cron start.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-2">
                <div className="text-xs font-bold text-slate-900">
                  1. Eenmalige Okta MFA Login ({config.authMethod === 'sharepoint-cookie-vault' ? '--init-cookies' : '--init-auth'})
                </div>
                <p className="text-[11px] text-slate-600">
                  {config.authMethod === 'sharepoint-cookie-vault'
                    ? 'Slaat FedAuth + rtFa cookies van uw Okta browsersessie versleuteld op in /vault.'
                    : `Start de Device Code Flow met Microsoft Office Client ID via ${config.oktaOrgUrl}.`}
                </p>
                <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                  <code className="truncate">
                    {config.authMethod === 'sharepoint-cookie-vault'
                      ? `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies`
                      : `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth`}
                  </code>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyCode(
                        'cmd-init',
                        config.authMethod === 'sharepoint-cookie-vault'
                          ? `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies`
                          : `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth`
                      )
                    }
                    className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    aria-label="Kopieer init commando"
                  >
                    {copiedId === 'cmd-init' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-2">
                <div className="text-xs font-bold text-slate-900">2. Verbindingstest (--verify)</div>
                <p className="text-[11px] text-slate-600">
                  Test sessie, SharePoint-pad, <span className="font-mono">Callsheets Archief</span> filter en schrijfrechten zonder te downloaden.
                </p>
                <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                  <code className="truncate">docker exec {config.dockerImageName} python3 /app/sync.py --verify</code>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyCode(
                        'cmd-verify',
                        `docker exec ${config.dockerImageName} python3 /app/sync.py --verify`
                      )
                    }
                    className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    aria-label="Kopieer verify commando"
                  >
                    {copiedId === 'cmd-verify' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-2">
                <div className="text-xs font-bold text-slate-900">3. Directe Test-sync (--force)</div>
                <p className="text-[11px] text-slate-600">
                  Test een echte download naar <span className="font-mono">{config.hostSyncVolumePath}</span> ook buiten 08:00–20:00.
                </p>
                <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                  <code className="truncate">docker exec {config.dockerImageName} python3 /app/sync.py --force</code>
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyCode(
                        'cmd-force',
                        `docker exec ${config.dockerImageName} python3 /app/sync.py --force`
                      )
                    }
                    className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    aria-label="Kopieer force commando"
                  >
                    {copiedId === 'cmd-force' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Mogelijke IT-blokkade bij NEP / Okta</th>
                    <th className="py-2.5 px-3">Wat u ziet tijdens --init-auth of --verify</th>
                    <th className="py-2.5 px-3">Oplossing ZONDER IT-goedkeuring</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">
                      GHCR Docker Pull geweigerd (Package is Private of nog niet gepusht)
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      Head &quot;https://ghcr.io/.../manifests/latest&quot;: denied
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      Log eenmalig in met een GitHub PAT (<code className="font-mono">read:packages</code>): <code className="font-mono">echo &quot;$PAT&quot; | docker login ghcr.io -u {config.githubRepo.split('/')[0]} --password-stdin</code>, of zet de package op GitHub op <strong>Public</strong>, of bouw lokaal met <code className="font-mono">docker compose up -d --build</code>.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">
                      App-consent geblokkeerd (geen IT goedkeuring)
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      AADSTS65001 / Need admin approval
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      Gebruik Optie 1 met het Microsoft First-Party Office ID (<code className="font-mono">d3590ed6-...</code>), of schakel over naar <strong>Optie 2 (Directe SharePoint REST API + FedAuth Cookie Vault)</strong> waar helemaal geen Entra App aan te pas komt.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">
                      Device Code Flow geblokkeerd door Conditional Access
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      AADSTS53003 / Device code flow blocked
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      Schakel bovenin over naar <strong>Optie 2 (SharePoint Cookie Vault)</strong> of <strong>Optie 3 (Rclone via eigen browser)</strong>. Beide werken zonder Device Code Flow.
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">
                      Okta Sign-In Frequency laat sessie verlopen
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600">
                      AADSTS50076 / HTTP 401-403
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      Door elke 2 uur (08:00–20:00) te pingen blijft de sessie actief. Als Okta toch opnieuw MFA afdwingt, ververs eenmalig met <code className="font-mono">--init-auth</code> of <code className="font-mono">--init-cookies</code>.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>

      <footer className="border-t border-slate-200 bg-white py-4 px-6 mt-auto">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>
            O365 Okta Sync Studio · GitHub Actions Build naar Lokale Docker Container (Device Code + Fernet Vault)
          </div>
          <div className="font-mono tabular-nums">
            Cron: {cronExpression} ({config.timezone})
          </div>
        </div>
      </footer>
    </div>
  );
}
