export interface AuthData {
  discordId: string;
  username: string;
  globalName: string;
  avatar: string | null;
  steamId?: string | null;
  loginDate: string;
}

export interface PublicServerStatus {
  state: 'online' | 'full' | 'starting' | 'maintenance' | 'offline';
  players: number;
  capacity: number;
  queue: number;
  message: string | null;
}

export type LaunchRepairAction = 'retry' | 'settings' | 'update-client' | 'update-mods' | 'repair-mods';

export type LaunchPreparationResult = {
  status: 'ready' | 'blocked';
  code?: string;
  action?: LaunchRepairAction;
  message?: string;
  problems?: string[];
  preparationToken?: string;
  expiresAt?: string;
};

export interface ElectronAPI {
  windowMinimize: () => void;
  windowClose: () => void;
  getLauncherConfig: () => Promise<{ gamePath?: string; display?: { width?: number; height?: number; mode?: string } }>;
  saveGamePath: (folderPath: string) => Promise<{ ok: boolean; reason?: string; message?: string; version?: string; platform?: string }>;
  selectGamePath: () => Promise<string | null>;
  checkGamePath: (folderPath: string) => Promise<{ ok: boolean; reason: string }>;
  ensureSkyrimIni: (opts?: any) => Promise<any>;
  getDisplaySettings: () => Promise<any>;
  discordLogin: () => Promise<AuthData | null>;
  discordLogout: () => Promise<boolean>;
  getAuthStatus: () => Promise<AuthData | null>;
  getServerStatus: () => Promise<PublicServerStatus>;
  joinQueue: (preparationToken: string, folderPath: string) => Promise<any>;
  pollQueue: (preparationToken: string, folderPath: string) => Promise<any>;
  getLocalPlugins: (folderPath: string) => Promise<any>;
  verifyMods: (folderPath: string) => Promise<{ success: boolean; error?: string; problems?: string[]; loadOrder?: string[] }>;
  analyzePlugins: (folderPath: string, serverLoadOrder?: string[]) => Promise<{ ok: boolean; problems: string[]; plugins: any[] }>;
  syncLoadorder: (folderPath: string, serverLoadOrder: string[]) => Promise<boolean>;
  isGameRunning: () => Promise<boolean>;
  killGame: () => Promise<boolean>;
  checkClientUpdate: (folderPath: string) => Promise<any>;
  installClientUpdate: (folderPath: string) => Promise<any>;
  checkModsUpdate: (folderPath: string) => Promise<any>;
  installModsUpdate: (folderPath: string, force?: boolean) => Promise<any>;
  repairModsIncremental: (folderPath: string, confirmed?: boolean) => Promise<any>;
  cancelUpdateOperation: () => Promise<{ success: boolean; reason?: string; alreadyRequested?: boolean }>;
  prepareToPlay: (folderPath: string) => Promise<LaunchPreparationResult>;
  rollbackLastUpdate: (folderPath: string) => Promise<any>;
  getRecentCrashes: () => Promise<Array<{ name: string; mtime: number }>>;
  reportRecentCrashes: () => Promise<any>;
  onUpdateProgress: (callback: (value: any) => void) => void;
  onModsUpdateProgress: (callback: (value: any) => void) => void;
  launchGame: (folderPath: string, ticket: string, preparationToken: string) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
