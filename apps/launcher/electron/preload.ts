import { contextBridge, ipcRenderer } from 'electron';

const api = {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),
  getLauncherConfig: () => ipcRenderer.invoke('get-launcher-config'),
  saveGamePath: (folderPath: string) => ipcRenderer.invoke('save-game-path', folderPath),
  selectGamePath: () => ipcRenderer.invoke('select-game-path'),
  checkGamePath: (folderPath: string) => ipcRenderer.invoke('check-game-path', folderPath),
  ensureSkyrimIni: (opts?: any) => ipcRenderer.invoke('ensure-skyrim-ini', opts),
  getDisplaySettings: () => ipcRenderer.invoke('get-display-settings'),
  discordLogin: () => ipcRenderer.invoke('discord-login'),
  discordLogout: () => ipcRenderer.invoke('discord-logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  joinQueue: (preparationToken: string, folderPath: string) => ipcRenderer.invoke('join-queue', preparationToken, folderPath),
  pollQueue: (preparationToken: string, folderPath: string) => ipcRenderer.invoke('poll-queue', preparationToken, folderPath),
  getLocalPlugins: (folderPath: string) => ipcRenderer.invoke('get-local-plugins', folderPath),
  verifyMods: (folderPath: string) => ipcRenderer.invoke('verify-mods', folderPath),
  analyzePlugins: (folderPath: string, serverLoadOrder?: string[]) => ipcRenderer.invoke('analyze-plugins', folderPath, serverLoadOrder),
  syncLoadorder: (folderPath: string, serverLoadOrder: string[]) => ipcRenderer.invoke('sync-loadorder', folderPath, serverLoadOrder),
  isGameRunning: () => ipcRenderer.invoke('is-game-running'),
  killGame: () => ipcRenderer.invoke('kill-game'),
  checkClientUpdate: (folderPath: string) => ipcRenderer.invoke('check-client-update', folderPath),
  installClientUpdate: (folderPath: string) => ipcRenderer.invoke('install-client-update', folderPath),
  checkModsUpdate: (folderPath: string) => ipcRenderer.invoke('check-mods-update', folderPath),
  installModsUpdate: (folderPath: string, force?: boolean) => ipcRenderer.invoke('install-mods-update', folderPath, force),
  repairModsIncremental: (folderPath: string, confirmed?: boolean) => ipcRenderer.invoke('repair-mods-incremental', folderPath, confirmed),
  cancelUpdateOperation: () => ipcRenderer.invoke('cancel-update-operation'),
  prepareToPlay: (folderPath: string) => ipcRenderer.invoke('prepare-to-play', folderPath),
  rollbackLastUpdate: (folderPath: string) => ipcRenderer.invoke('rollback-last-update', folderPath),
  getRecentCrashes: () => ipcRenderer.invoke('get-recent-crashes'),
  reportRecentCrashes: () => ipcRenderer.invoke('report-recent-crashes'),
  onUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_event, value) => callback(value));
  },
  onModsUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('mods-update-progress');
    ipcRenderer.on('mods-update-progress', (_event, value) => callback(value));
  },
  launchGame: (folderPath: string, ticket: string, preparationToken: string) => ipcRenderer.invoke('launch-game', folderPath, ticket, preparationToken)
};

contextBridge.exposeInMainWorld('electronAPI', api);
