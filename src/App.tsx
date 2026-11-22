import React, { useState, useMemo, useEffect } from 'react';
import {
  ShieldCheck,
  Clock,
  Terminal,
  Copy,
  Check,
  Download,
  Play,
  Lock,
  FileText,
  RefreshCw,
  Plus,
  Search,
  SlidersHorizontal,
  FolderX,
  Trash2,
  AlertTriangle
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
  generateDockerPythonSyncScript,
  generateRepoBootstrapScript
} from './utils/scriptGenerators';

type WorkspaceTab = 'scripts' | 'simulatie' | 'verificatie';
type ScriptTab = 'docker-compose' | 'dockerfile' | 'github-workflow' | 'sync-py' | 'entrypoint' | 'setup-repo';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('simulatie');
  const [scriptTab, setScriptTab] = useState<ScriptTab>('docker-compose');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [config, setConfig] = useState<SyncConfig>({
    tenantDomain: 'nepinc.sharepoint.com',
    sharepointSiteName: 'NEPNL-Operations',
    sharedFolderPath: '/02. Callsheets',
    ignoredFolders: ['Callsheets Archief'],
    hostSyncVolumePath: '/opt/docker/callsheets/data',
    hostVaultVolumePath: '/opt/docker/callsheets/vault',
    containerDataPath: '/data/sync',
    containerVaultPath: '/vault',
    oktaOrgUrl: 'https://nepglobal.okta.com',
    usernameHint: 'voornaam.achternaam@nepworldwide.nl',
    clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
    authMethod: 'sharepoint-cookie-vault',
    githubRepo: 'ckb-k28/oktasync',
    dockerImageName: 'oktasync',
    timezone: 'Europe/Amsterdam',
    startHour: 8,
    endHour: 20,
    intervalHours: 2,
    weekdaysOnly: false
  });

  const [newIgnoreFolder, setNewIgnoreFolder] = useState<string>('');

  // 60-Minute Access Token Time-to-Live (TTL) State for Sync Simulator
  const [tokenExpiryMinutes, setTokenExpiryMinutes] = useState<number>(46);
  const [autoDecayTtl, setAutoDecayTtl] = useState<boolean>(true);

  // Simulation state
  const [files, setFiles] = useState<SyncFileItem[]>(INITIAL_SYNC_FILES);
  const [runLogs, setRunLogs] = useState<SyncRunLog[]>(INITIAL_RUN_LOGS);
  const [selectedSlot, setSelectedSlot] = useState<string>('14:00');
  const [fileSearch, setFileSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'alle' | 'gesynchroniseerd' | 'nieuw' | 'gewijzigd' | 'overgeslagen'>('alle');
  const [isSimulatingRun, setIsSimulatingRun] = useState<boolean>(false);

  // Live countdown timer for simulated 60-minute Access Token TTL
  useEffect(() => {
    if (!autoDecayTtl) return;
    const timer = setInterval(() => {
      setTokenExpiryMinutes((prev) => Math.max(0, prev - 1));
    }, 3000);
    return () => clearInterval(timer);
  }, [autoDecayTtl]);

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
        label: 'Lokale Docker Host configuratie (Poort 5555, /opt/docker/callsheets/{data,vault})',
        content: generateDockerComposeYaml(config)
      },
      'dockerfile': {
        filename: 'Dockerfile',
        label: 'Multi-stage Linux/amd64 Container (Web UI Poort 5555 + Supercronic)',
        content: generateDockerfile(config)
      },
      'github-workflow': {
        filename: '.github/workflows/docker-publish.yml',
        label: 'GitHub Actions Build & Push naar GHCR bij elke git push',
        content: generateGithubWorkflowYaml(config)
      },
      'sync-py': {
        filename: 'sync.py',
        label: 'Python SharePoint Cookie Vault & Graph Sync Script',
        content: generateDockerPythonSyncScript(config)
      },
      'entrypoint': {
        filename: 'entrypoint.sh',
        label: 'Container Entrypoint (Web Server Poort 5555 + Supercronic)',
        content: generateEntrypointScript(config)
      },
      'setup-repo': {
        filename: 'setup-repo.sh',
        label: '1-Stap Repo Setup & Git Push Script',
        content: generateRepoBootstrapScript(config)
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

  // Token TTL status computation based on 60-minute expiration logic
  const ttlPercentage = Math.min(100, Math.max(0, Math.round((tokenExpiryMinutes / 60) * 100)));
  const ttlState = useMemo(() => {
    if (tokenExpiryMinutes === 0) {
      return {
        level: 'verlopen' as const,
        label: 'Access Token Verlopen (0 min resterend)',
        description:
          'De 60-minuten TTL is verstreken. Bij het eerstvolgende 2-uurlijkse Supercronic-slot haalt de container automatisch een nieuw 60-minuten Access Token op uit de versleutelde Fernet-kluis (/vault).',
        barColor: 'bg-red-600',
        borderColor: 'border-red-300 bg-red-50/70',
        textColor: 'text-red-800'
      };
    }
    if (tokenExpiryMinutes <= 15) {
      return {
        level: 'kritiek' as const,
        label: `Waarschuwing: Token verloopt bijna (${tokenExpiryMinutes} / 60 min)`,
        description:
          'Minder dan 15 minuten resterend op het huidige 60-minuten token. Stille token-rotatie via Okta/SharePoint kluis staat klaar voor de volgende sync.',
        barColor: 'bg-amber-500',
        borderColor: 'border-amber-300 bg-amber-50/70',
        textColor: 'text-amber-900'
      };
    }
    return {
      level: 'gezond' as const,
      label: `Access Token Actief (${tokenExpiryMinutes} / 60 min TTL)`,
      description:
        'Huidig token is geldig binnen het 60-minuten venster. Elke 2-uurlijkse sync vernieuwt de sessie automatisch op basis van de 60-minuten verloop-logica.',
      barColor: 'bg-emerald-600',
      borderColor: 'border-slate-200 bg-slate-50',
      textColor: 'text-emerald-800'
    };
  }, [tokenExpiryMinutes]);

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
      const hadExpiredOrLowToken = tokenExpiryMinutes <= 15;

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
      // Reset Access Token TTL back to full 60 minutes upon sync execution
      setTokenExpiryMinutes(60);

      const ignoredNote =
        config.ignoredFolders.length > 0
          ? ` Genegeerd: ${config.ignoredFolders.join(', ')} (${ignoredCount}).`
          : '';

      const vaultFileLabel =
        config.authMethod === 'sharepoint-cookie-vault' ? 'sp_cookies.enc' : 'token_cache.enc';

      const newLog: SyncRunLog = {
        id: `run-${Date.now()}`,
        slotTime,
        executedAt: `Vandaag ${slotTime}:02 (${config.dockerImageName})`,
        authModeUsed: `Fernet Kluis (${config.containerVaultPath}/${vaultFileLabel})`,
        tokenStatus: hadExpiredOrLowToken
          ? 'Verlopen token stilzwijgend vernieuwd -> TTL 60m'
          : 'Token gevalideerd & geroteerd -> TTL 60m',
        filesChecked: updatedFiles.length + 34,
        filesDownloaded: downloadedCount,
        bytesTransferred: transferredBytes,
        durationMs: downloadedCount > 0 ? 1320 + downloadedCount * 380 : 620,
        status: 'voltooid',
        details:
          downloadedCount > 0
            ? `Slot ${slotTime}: ${downloadedCount} bestand(en) gedownload naar ${config.hostSyncVolumePath}.${ignoredNote}`
            : `Slot ${slotTime}: Geen gewijzigde bestanden sinds vorige controle.${ignoredNote}`
      };

      setRunLogs((prev) => [newLog, ...prev]);
      setIsSimulatingRun(false);
    }, 300);
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

  const appVersion = import.meta.env.VITE_APP_VERSION || 'v.01';

  const initCmd =
    config.authMethod === 'sharepoint-cookie-vault'
      ? `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-cookies`
      : `docker exec -it ${config.dockerImageName} python3 /app/sync.py --init-auth`;

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Responsive Top Bar: Brand + Run CTA on top row (mobile), Full-width Scrollable Tabs on second row (mobile) / inline on desktop */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 px-4 sm:px-6 py-3">
        <div className="max-w-[1440px] mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base font-bold tracking-tight text-slate-900 truncate">
                O365 Okta Sync
              </span>
              <span className="text-[11px] font-mono font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded shrink-0">
                {appVersion}
              </span>
              <span className="text-xs font-mono text-slate-500 hidden sm:inline truncate">
                ghcr.io/{config.githubRepo.toLowerCase()} · :5555
              </span>
            </div>

            {/* Mobile Primary Action Button */}
            <button
              type="button"
              onClick={() => handleTriggerSyncSlot(selectedSlot)}
              disabled={isSimulatingRun}
              className="md:hidden px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {isSimulatingRun ? 'Bezig...' : `Sync (${selectedSlot})`}
            </button>
          </div>

          {/* Navigation Tabs - Responsive Grid on Mobile, Segmented Bar on Desktop */}
          <nav className="grid grid-cols-3 md:flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-full md:w-auto">
            <button
              type="button"
              onClick={() => setActiveTab('simulatie')}
              className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors text-center truncate cursor-pointer ${
                activeTab === 'simulatie'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Simulator & TTL
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('scripts')}
              className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors text-center truncate cursor-pointer ${
                activeTab === 'scripts'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Docker & GitHub
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('verificatie')}
              className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors text-center truncate cursor-pointer ${
                activeTab === 'verificatie'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Host Diagnose
            </button>
          </nav>

          {/* Desktop Primary Action Button */}
          <button
            type="button"
            onClick={() => handleTriggerSyncSlot(selectedSlot)}
            disabled={isSimulatingRun}
            className="hidden md:flex px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors whitespace-nowrap shrink-0 items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {isSimulatingRun ? 'Bezig...' : `Run Sync (${selectedSlot})`}
          </button>
        </div>
      </header>

      {/* Main Workspace: Mobile shows Active Workspace First, Config Sidebar Second */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 px-4 sm:px-6 py-5 sm:py-6">
        {/* Left Column on Desktop / Second on Mobile: Streamlined Configuration */}
        <aside className="lg:col-span-4 order-2 lg:order-1 space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900">Container Configuratie</h2>
                <p className="text-xs text-slate-500">
                  Wijzigingen werken direct door in alle Docker-bestanden.
                </p>
              </div>
              <SlidersHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Authenticatie Methode (Zonder IT-goedkeuring)
                </label>
                <select
                  value={config.authMethod}
                  onChange={(e) =>
                    setConfig({ ...config, authMethod: e.target.value as AuthMethodId })
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  <option value="sharepoint-cookie-vault">
                    1. SharePoint REST API + Okta Cookie Kluis (Aanbevolen)
                  </option>
                  <option value="oauth2-device-fernet">
                    2. Microsoft Graph CLI (14d82eec) + Fernet Kluis
                  </option>
                  <option value="rclone-docker-encrypted">
                    3. Rclone Container + Versleutelde Config
                  </option>
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  {selectedStrategy.subtitle}
                </p>
              </div>

              {config.authMethod === 'oauth2-device-fernet' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Microsoft First-Party Client ID
                  </label>
                  <select
                    value={config.clientId}
                    onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    <option value="14d82eec-204b-4c2f-b7e8-296a70dab67e">
                      14d82eec-... (Microsoft Graph CLI)
                    </option>
                    <option value="ab9b8c07-8f02-4f72-87fa-80105867a763">
                      ab9b8c07-... (OneDrive SyncEngine)
                    </option>
                    <option value="9bc3ab49-b65d-410a-85ad-bf819febf99b">
                      9bc3ab49-... (SharePoint Online Client)
                    </option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SharePoint Domein
                  </label>
                  <input
                    type="text"
                    value={config.tenantDomain}
                    onChange={(e) => setConfig({ ...config, tenantDomain: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Site Naam
                  </label>
                  <input
                    type="text"
                    value={config.sharepointSiteName}
                    onChange={(e) => setConfig({ ...config, sharepointSiteName: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Gedeelde Map in SharePoint
                </label>
                <input
                  type="text"
                  value={config.sharedFolderPath}
                  onChange={(e) => setConfig({ ...config, sharedFolderPath: e.target.value })}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Genegeerde Submappen (Ignore List)
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
                    className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 min-w-0"
                  />
                  <button
                    type="button"
                    onClick={handleAddIgnoreFolder}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
                  >
                    +
                  </button>
                </div>
                {config.ignoredFolders.length > 0 && (
                  <div className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-lg bg-slate-50">
                    {config.ignoredFolders.map((folder) => (
                      <div
                        key={folder}
                        className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-mono text-slate-800 flex items-center gap-1.5 truncate">
                          <FolderX className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          <span className="truncate">{folder}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveIgnoreFolder(folder)}
                          aria-label={`Verwijder ${folder}`}
                          className="text-slate-400 hover:text-red-600 transition-colors p-0.5 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Host Data Map (Callsheets)
                  </label>
                  <input
                    type="text"
                    value={config.hostSyncVolumePath}
                    onChange={(e) => setConfig({ ...config, hostSyncVolumePath: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Host Vault Map (Kluis)
                  </label>
                  <input
                    type="text"
                    value={config.hostVaultVolumePath}
                    onChange={(e) => setConfig({ ...config, hostVaultVolumePath: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    GitHub Repo
                  </label>
                  <input
                    type="text"
                    value={config.githubRepo}
                    onChange={(e) => setConfig({ ...config, githubRepo: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Okta Login URL
                  </label>
                  <input
                    type="text"
                    value={config.oktaOrgUrl}
                    onChange={(e) => setConfig({ ...config, oktaOrgUrl: e.target.value })}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-700">
                    Schema ({config.timezone})
                  </label>
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                    {cronExpression}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-0.5">Start (u)</span>
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
                      className="w-full px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-0.5">Eind (u)</span>
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
                      className="w-full px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-500 mb-0.5">Stap</span>
                    <select
                      value={config.intervalHours}
                      onChange={(e) =>
                        setConfig({ ...config, intervalHours: Number(e.target.value) })
                      }
                      className="w-full px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <option value={1}>1 uur</option>
                      <option value={2}>2 uur</option>
                      <option value={3}>3 uur</option>
                      <option value={4}>4 uur</option>
                    </select>
                  </div>
                </div>

                <label className="text-xs text-slate-700 font-medium flex items-center gap-2 mt-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.weekdaysOnly}
                    onChange={(e) => setConfig({ ...config, weekdaysOnly: e.target.checked })}
                    className="rounded border-slate-300 text-slate-900"
                  />
                  Alleen op werkdagen (Ma–Vr)
                </label>
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column on Desktop / First on Mobile: Focused Tab Content */}
        <main className="lg:col-span-8 order-1 lg:order-2 space-y-5 sm:space-y-6">
          {/* Compact 3-Metric Summary Bar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-3.5 sm:gap-4">
            <div className="min-w-0">
              <div className="text-xs text-slate-500">Supercronic Schema</div>
              <div className="text-sm font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                {cronExpression} ({timeSlots.length}x / dag)
              </div>
              <div className="text-[11px] text-slate-500">
                {timeSlots[0]} t/m {timeSlots[timeSlots.length - 1]} · {config.timezone}
              </div>
            </div>

            <div className="min-w-0">
              <div className="text-xs text-slate-500">Actieve Kluis (/vault)</div>
              <div className="text-sm font-bold text-emerald-700 mt-0.5 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {config.authMethod === 'sharepoint-cookie-vault'
                    ? 'sp_cookies.enc (FedAuth)'
                    : config.authMethod === 'rclone-docker-encrypted'
                    ? 'rclone.conf (AES-256)'
                    : 'token_cache.enc (Fernet)'}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono truncate">
                {config.hostVaultVolumePath}
              </div>
            </div>

            <div className="min-w-0">
              <div className="text-xs text-slate-500">Host Data Map & Filter</div>
              <div className="text-sm font-bold font-mono text-slate-900 mt-0.5 truncate">
                {config.hostSyncVolumePath}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                Negeert: {config.ignoredFolders.join(', ') || 'Geen'}
              </div>
            </div>
          </div>

          {/* TAB 1: SYNC SIMULATOR & ACCESS TOKEN TTL MONITOR */}
          {activeTab === 'simulatie' && (
            <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5 sm:space-y-6">
              {/* Visual 60-Minute Access Token Time-to-Live (TTL) Status & Progress Bar */}
              <div className={`border rounded-xl p-3.5 sm:p-4 space-y-3 transition-colors ${ttlState.borderColor}`}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2">
                    {ttlState.level === 'gezond' ? (
                      <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <AlertTriangle
                        className={`w-4 h-4 shrink-0 ${
                          ttlState.level === 'verlopen' ? 'text-red-600' : 'text-amber-600'
                        }`}
                      />
                    )}
                    <span className={`text-xs font-bold ${ttlState.textColor}`}>
                      {ttlState.label}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 sm:flex items-center gap-1.5 sm:gap-2">
                    <button
                      type="button"
                      onClick={() => setTokenExpiryMinutes(12)}
                      className="px-2 py-1 text-[11px] font-medium bg-white border border-slate-300 text-slate-700 rounded hover:bg-slate-100 transition-colors text-center cursor-pointer"
                    >
                      Test &lt;15m
                    </button>
                    <button
                      type="button"
                      onClick={() => setTokenExpiryMinutes(0)}
                      className="px-2 py-1 text-[11px] font-medium bg-white border border-slate-300 text-slate-700 rounded hover:bg-slate-100 transition-colors text-center cursor-pointer"
                    >
                      Test 0m
                    </button>
                    <button
                      type="button"
                      onClick={() => setTokenExpiryMinutes(60)}
                      className="px-2 py-1 text-[11px] font-semibold bg-slate-900 text-white rounded hover:bg-slate-800 transition-colors text-center cursor-pointer"
                    >
                      Reset 60m
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1.5">
                  <div className="w-full h-2.5 bg-slate-200/80 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${ttlState.barColor}`}
                      style={{ width: `${ttlPercentage}%` }}
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-slate-600">
                    <span>{ttlState.description}</span>
                    <label className="flex items-center gap-1.5 font-mono shrink-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoDecayTtl}
                        onChange={(e) => setAutoDecayTtl(e.target.checked)}
                        className="rounded border-slate-300 text-slate-900"
                      />
                      Live aftellen ({ttlPercentage}%)
                    </label>
                  </div>
                </div>
              </div>

              {/* 08:00 - 20:00 Time Slots Strip */}
              <div className="space-y-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Supercronic Tijdslots ({String(config.startHour).padStart(2, '0')}:00 – {String(config.endHour).padStart(2, '0')}:00)
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                    Tik op een slot om een sync te testen (zet TTL op 60m)
                  </span>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2">
                  {timeSlots.map((slot) => {
                    const completedLog = runLogs.find((l) => l.slotTime === slot);
                    const isSelected = selectedSlot === slot;
                    return (
                      <button
                        key={slot}
                        type="button"
                        onClick={() => handleTriggerSyncSlot(slot)}
                        className={`p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                          isSelected
                            ? 'border-slate-900 bg-slate-900 text-white'
                            : completedLog
                            ? 'border-emerald-200 bg-emerald-50/50 text-slate-900 hover:border-emerald-400'
                            : 'border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold font-mono tabular-nums">{slot}</span>
                          <Clock className={`w-3 h-3 ${isSelected ? 'text-slate-300' : 'text-slate-400'}`} />
                        </div>
                        <div
                          className={`text-[11px] mt-1 font-medium truncate ${
                            isSelected
                              ? 'text-slate-200'
                              : completedLog
                              ? 'text-emerald-700'
                              : 'text-slate-500'
                          }`}
                        >
                          {completedLog ? `${completedLog.filesDownloaded} nieuw` : 'Gepland'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Files Header & Controls */}
              <div className="flex flex-col gap-3 pt-2 border-t border-slate-100">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Zoek bestand of submap..."
                      value={fileSearch}
                      onChange={(e) => setFileSearch(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>

                  <div className="grid grid-cols-2 sm:flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={handleAddSimulatedRemoteFile}
                      className="px-2.5 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-900 rounded-lg transition-colors flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Nieuw Bestand
                    </button>

                    <button
                      type="button"
                      onClick={() => handleTriggerSyncSlot(selectedSlot)}
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isSimulatingRun ? 'animate-spin' : ''}`} />
                      Sync Nu ({pendingFilesCount})
                    </button>
                  </div>
                </div>

                {/* Status Filter Bar - Scrollable on small mobile screens */}
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                  {(['alle', 'nieuw', 'gewijzigd', 'gesynchroniseerd', 'overgeslagen'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setStatusFilter(st)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors capitalize whitespace-nowrap shrink-0 cursor-pointer ${
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

              {/* Mobile File Cards (< sm) & Desktop Table (sm+) */}
              <div className="sm:hidden divide-y divide-slate-200 border border-slate-200 rounded-lg">
                {filteredFiles.length === 0 ? (
                  <div className="py-6 px-3 text-center text-xs text-slate-500">
                    Geen bestanden gevonden voor dit filter.
                  </div>
                ) : (
                  filteredFiles.map((file) => (
                    <div key={file.id} className="p-3 space-y-1.5 text-xs">
                      <div className="font-semibold text-slate-900 flex items-start gap-1.5 break-all">
                        <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span>{file.name}</span>
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 break-all">
                        {file.relativePath}
                      </div>
                      <div className="flex items-center justify-between pt-1 text-[11px]">
                        <span className="font-mono text-slate-600">
                          {formatBytes(file.sizeBytes)} · {file.modifiedAt}
                        </span>
                        {file.status === 'gesynchroniseerd' && (
                          <span className="text-emerald-700 font-medium">
                            Sync ({file.syncedAtSlot})
                          </span>
                        )}
                        {file.status === 'nieuw' && (
                          <span className="text-amber-700 font-semibold">Nieuw</span>
                        )}
                        {file.status === 'gewijzigd' && (
                          <span className="text-amber-700 font-semibold">Gewijzigd</span>
                        )}
                        {file.status === 'overgeslagen' && (
                          <span className="text-slate-500 font-medium">Genegeerd</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="hidden sm:block overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="py-2 px-3">Bestandsnaam & SharePoint Pad</th>
                      <th className="py-2 px-3 text-right">Grootte</th>
                      <th className="py-2 px-3 text-right">Gewijzigd</th>
                      <th className="py-2 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {filteredFiles.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          Geen bestanden gevonden voor dit filter.
                        </td>
                      </tr>
                    ) : (
                      filteredFiles.map((file) => (
                        <tr key={file.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                              <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{file.name}</span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-500">
                              {file.relativePath}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                            {formatBytes(file.sizeBytes)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                            {file.modifiedAt}
                          </td>
                          <td className="py-2 px-3">
                            {file.status === 'gesynchroniseerd' && (
                              <span className="text-emerald-700 font-medium">
                                Gesynchroniseerd ({file.syncedAtSlot})
                              </span>
                            )}
                            {file.status === 'nieuw' && (
                              <span className="text-amber-700 font-semibold">
                                Nieuw (wacht op sync)
                              </span>
                            )}
                            {file.status === 'gewijzigd' && (
                              <span className="text-amber-700 font-semibold">
                                Gewijzigd op O365
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

              {/* Compact Container Run Logs */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Recente Container Runs (Supercronic Log)
                  </h3>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Laatste {Math.min(4, runLogs.length)} van {runLogs.length}
                  </span>
                </div>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/50">
                  {runLogs.slice(0, 4).map((log) => (
                    <div key={log.id} className="p-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-semibold text-slate-900 flex-wrap">
                          <span className="font-mono">{log.slotTime}</span>
                          <span className="text-slate-400">·</span>
                          <span className="text-emerald-700">{log.tokenStatus}</span>
                        </div>
                        <p className="text-slate-600 text-[11px] break-words">{log.details}</p>
                      </div>
                      <div className="sm:text-right font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                        {log.filesDownloaded} nieuw · {formatBytes(log.bytesTransferred)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* TAB 2: DOCKER & GITHUB FILES */}
          {activeTab === 'scripts' && (
            <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-4">
              <div className="flex flex-col gap-3 border-b border-slate-100 pb-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Project- & Containerbestanden (linux/amd64 · Poort 5555)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Volumes: <code className="font-mono">{config.hostSyncVolumePath}</code> (data) en <code className="font-mono">{config.hostVaultVolumePath}</code> (vault).
                  </p>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                  {(
                    [
                      ['docker-compose', 'docker-compose.yml'],
                      ['dockerfile', 'Dockerfile'],
                      ['github-workflow', 'GitHub Action'],
                      ['sync-py', 'sync.py'],
                      ['entrypoint', 'entrypoint.sh'],
                      ['setup-repo', 'setup-repo.sh']
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setScriptTab(key)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        scriptTab === key
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-900 text-slate-200 px-3.5 sm:px-4 py-2.5 rounded-t-lg border-b border-slate-800">
                  <div className="flex items-center gap-2 text-xs font-mono min-w-0">
                    <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="truncate">{generatedScripts[scriptTab].filename}</span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleCopyCode(scriptTab, generatedScripts[scriptTab].content)}
                      className="flex-1 sm:flex-initial justify-center px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedId === scriptTab ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          Gekopieerd
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Kopieer
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleDownloadScript(
                          generatedScripts[scriptTab].filename,
                          generatedScripts[scriptTab].content
                        )
                      }
                      className="flex-1 sm:flex-initial justify-center px-2.5 py-1 text-xs font-medium bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>
                </div>

                <pre className="bg-slate-950 text-slate-100 p-3.5 sm:p-4 rounded-b-lg text-xs font-mono overflow-x-auto max-h-[460px] leading-relaxed">
                  <code>{generatedScripts[scriptTab].content}</code>
                </pre>
              </div>
            </section>
          )}

          {/* TAB 3: HOST COMMANDS & TROUBLESHOOTING */}
          {activeTab === 'verificatie' && (
            <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5 sm:space-y-6">
              <div className="border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-900">
                  Verificatie op uw Docker Host & Foutdiagnose
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Voer deze 3 stappen uit op uw lokale Docker server nadat de container via <code className="font-mono">docker compose up -d</code> is gestart.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 sm:gap-4">
                <div className="border border-slate-200 rounded-lg p-3.5 sm:p-4 bg-slate-50 space-y-2">
                  <div className="text-xs font-bold text-slate-900">
                    1. Eenmalige Okta Sessie Opslaan
                  </div>
                  <p className="text-[11px] text-slate-600">
                    Sla uw Okta/SharePoint sessie versleuteld op in <code className="font-mono">{config.hostVaultVolumePath}</code>:
                  </p>
                  <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                    <code className="break-all">{initCmd}</code>
                    <button
                      type="button"
                      onClick={() => handleCopyCode('cmd-init', initCmd)}
                      className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    >
                      {copiedId === 'cmd-init' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-lg p-3.5 sm:p-4 bg-slate-50 space-y-2">
                  <div className="text-xs font-bold text-slate-900">2. Verbindingstest (--verify)</div>
                  <p className="text-[11px] text-slate-600">
                    Controleert kluis, SharePoint-map, ignore-filter en schrijfrechten:
                  </p>
                  <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                    <code className="break-all">docker exec {config.dockerImageName} python3 /app/sync.py --verify</code>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyCode(
                          'cmd-verify',
                          `docker exec ${config.dockerImageName} python3 /app/sync.py --verify`
                        )
                      }
                      className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    >
                      {copiedId === 'cmd-verify' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-lg p-3.5 sm:p-4 bg-slate-50 space-y-2">
                  <div className="text-xs font-bold text-slate-900">3. Directe Sync (--force)</div>
                  <p className="text-[11px] text-slate-600">
                    Start direct een synchronisatie naar <code className="font-mono">{config.hostSyncVolumePath}</code>:
                  </p>
                  <div className="bg-slate-900 text-slate-100 p-2.5 rounded font-mono text-[11px] flex items-center justify-between gap-2">
                    <code className="break-all">docker exec {config.dockerImageName} python3 /app/sync.py --force</code>
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyCode(
                          'cmd-force',
                          `docker exec ${config.dockerImageName} python3 /app/sync.py --force`
                        )
                      }
                      className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                    >
                      {copiedId === 'cmd-force' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Veelvoorkomende Foutmeldingen & Oplossingen
                </h3>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                  <div className="p-3.5 space-y-1 text-xs">
                    <div className="font-mono font-bold text-slate-900">
                      AADSTS65001 / AADSTS65002 (Entra ID blokkeert OAuth-app consent)
                    </div>
                    <p className="text-slate-600">
                      Gebruik <strong>Optie 1 (<code className="font-mono">--init-cookies</code>)</strong>. Hiermee gebruikt de container de directe SharePoint REST API met uw Okta-browsersessie zonder Entra App.
                    </p>
                  </div>
                  <div className="p-3.5 space-y-1 text-xs">
                    <div className="font-mono font-bold text-slate-900">
                      PermissionError: /vault/sp_cookies.enc
                    </div>
                    <p className="text-slate-600">
                      Voer op de host <code className="font-mono break-all">chown -R 1000:1000 {config.hostSyncVolumePath} {config.hostVaultVolumePath}</code> uit of pull de nieuwste image via <code className="font-mono">docker compose pull && docker compose up -d</code>.
                    </p>
                  </div>
                  <div className="p-3.5 space-y-1 text-xs">
                    <div className="font-mono font-bold text-slate-900">
                      Head &quot;https://ghcr.io/.../latest&quot;: denied
                    </div>
                    <p className="text-slate-600">
                      GHCR package staat op Private. Log in via <code className="font-mono">docker login ghcr.io -u {config.githubRepo.split('/')[0]}</code> of bouw lokaal met <code className="font-mono">docker compose up -d --build</code>.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
