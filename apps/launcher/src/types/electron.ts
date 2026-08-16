export interface AuthData {
  discordId: string;
  username: string;
  globalName: string;
  avatar: string | null;
  loginDate: string;
}

export interface PublicServerStatus {
  state: 'online' | 'full' | 'starting' | 'maintenance' | 'offline';
  players: number;
  capacity: number;
  queue: number;
  message: string | null;
}

export interface ElectronAPI {
  windowMinimize: () => void;
  windowClose: () => void;
  getLauncherConfig: () => Promise<{ gamePath?: string; display?: { width?: number; height?: number; mode?: string } }>;
  saveGamePath: (folderPath: string) => Promise<{ ok: boolean; reason?: string }>;
  selectGamePath: () => Promise<string | null>;
  checkGamePath: (folderPath: string) => Promise<{ ok: boolean; reason: string }>;
  ensureSkyrimIni: (opts?: any) => Promise<any>;
  getDisplaySettings: () => Promise<any>;
  discordLogin: () => Promise<AuthData | null>;
  discordLogout: () => Promise<boolean>;
  getAuthStatus: () => Promise<AuthData | null>;
  getServerStatus: () => Promise<PublicServerStatus>;
  joinQueue: () => Promise<any>;
  pollQueue: () => Promise<any>;
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
  getRecentCrashes: () => Promise<Array<{ name: string; mtime: number }>>;
  reportRecentCrashes: () => Promise<any>;
  onUpdateProgress: (callback: (value: any) => void) => void;
  onModsUpdateProgress: (callback: (value: any) => void) => void;
  launchGame: (folderPath: string, ticket: string) => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
