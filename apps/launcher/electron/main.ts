import { app, BrowserWindow, ipcMain, dialog, screen } from 'electron';
import path from 'path';
import { exec, execFile, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import { parsePluginsTxt, parsePluginHeader, analyzePlugins, parseCccTxt, analyzeCreationClub } from './parity.mjs';
import { buildSkyMpClientSettings, validateSkyMpSession } from './auth-settings.mjs';
import { inspectArchiveForExtraction } from './archive-safety.mjs';
import { assertTrustedUpdateUrl } from './remote-source-policy.mjs';
import { normalizeServerStatus, offlineServerStatus } from './server-status.mjs';
import { inspectManifestForRepair } from './modpack-repair.mjs';
import { inspectSteamSkyrimInstallation } from './game-installation.mjs';
import { findUnexpectedDataFiles, inspectDataTree } from './data-tree.mjs';
import { UpdateOperationCoordinator, throwIfUpdateCancelled } from './update-operation.mjs';
import {
  assertPayloadChannel,
  githubFeedUrl,
  installedReleaseForChannel,
  parseUpdateChannel,
  rememberedReleaseCandidates,
  releaseForChannel,
  releaseStateKey,
  type UpdateChannel,
} from './update-channel.mjs';
import {
  LaunchPreparationStore,
  classifyParityReadiness,
  classifyUpdateReadiness,
} from './launch-readiness.mjs';
import {
  commitInstallTransaction,
  createInstallTransaction,
  discardInstallTransaction,
  rollbackLastInstall,
  type InstallTransaction,
} from './transactional-installer.mjs';
import {
  chooseHighestRelease,
  readInstalledRelease,
  readRememberedReleases,
  rememberAcceptedRelease,
  serializeReleaseState,
  verifySignedUpdateEnvelope,
} from './update-manifest-security.mjs';
import manifestContract from '../../../skymp/packages/mods-manifest-contract.js';

// ─── Constants & Env ───
// Estes valores são substituídos em tempo de build pelo `define` do
// vite.config.ts — em runtime não existe `.env` do lado do app empacotado.
// VITE_DISCORD_CLIENT_SECRET foi removido de propósito: o secret vive só no
// painel web (ver POST /api/launcher/oauth/exchange).
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = process.env.VITE_DISCORD_REDIRECT_URI || 'http://localhost:19847/callback';
const SERVER_IP = process.env.VITE_SERVER_IP || '127.0.0.1';
// Default 7777 pra bater com o "port" de skymp/config/server-settings.*.json.
// O default anterior era 7757, que nao existia em lugar nenhum do lado servidor.
const SERVER_PORT = parseInt(process.env.VITE_SERVER_PORT || '7777', 10);
const API_PORT = parseInt(process.env.VITE_API_PORT || '7758', 10);
const DIST_REPO = process.env.VITE_GITHUB_DIST_REPO || '';
const UPDATE_PUBLIC_KEYS = process.env.VITE_UPDATE_PUBLIC_KEYS || '';
const CLIENT_UPDATE_CHANNEL: UpdateChannel = parseUpdateChannel(process.env.VITE_CLIENT_UPDATE_CHANNEL || 'stable', 'VITE_CLIENT_UPDATE_CHANNEL');
const MODS_UPDATE_CHANNEL: UpdateChannel = parseUpdateChannel(process.env.VITE_MODS_UPDATE_CHANNEL || CLIENT_UPDATE_CHANNEL, 'VITE_MODS_UPDATE_CHANNEL');
const PANEL_URL = (process.env.VITE_PANEL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const AUTH_FILE = path.join(app.getPath('userData'), 'auth.json');
const LAUNCHER_CONFIG_FILE = path.join(app.getPath('userData'), 'launcher-config.json');
const CLIENT_VERSION_FILENAME = 'skymp_client_version.txt';
const MODS_VERSION_FILENAME = 'skymp_mods_version.txt';
const MODS_PARTS_FILENAME = 'skymp_mods_parts.json';
const CLIENT_FILES_FILENAME = 'skymp_client_files.json';
const CLIENT_RELEASE_FILENAME = 'skymp_client_release.json';
const MODS_RELEASE_FILENAME = 'skymp_mods_release.json';
const UPDATE_SECURITY_FILE = path.join(app.getPath('userData'), 'update-security.json');
const RESERVED_UPDATE_FILES = new Set([
  CLIENT_VERSION_FILENAME,
  MODS_VERSION_FILENAME,
  MODS_PARTS_FILENAME,
  CLIENT_FILES_FILENAME,
  CLIENT_RELEASE_FILENAME,
  MODS_RELEASE_FILENAME,
].map(value => value.toLocaleLowerCase('en-US')));
const { validateModsManifestContract } = manifestContract;

let mainWindow: BrowserWindow | null = null;
const updateOperations = new UpdateOperationCoordinator();
const launchPreparations = new LaunchPreparationStore();

type LauncherConfig = {
  gamePath?: string;
  display?: {
    width?: number;
    height?: number;
    mode?: 'borderless' | 'windowed' | 'fullscreen';
  };
};

type PluginHeader = {
  masters: string[];
  isMaster: boolean;
  isLight: boolean;
  error?: string;
};

// [VOIP-NOTHROTTLE] - Previne gargalos no jogo quando em background
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 1024,
    minHeight: 640,
    title: "Skyrim Heavy RP Launcher",
    icon: path.join(__dirname, '../public/logo.png'),
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // ─── Navigation hardening ───
  // The main window carries the full electronAPI preload, so it must never be
  // allowed to navigate to (or open) an arbitrary/attacker-controlled origin.
  const allowedOrigin = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : 'file://';

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      const isAllowed = process.env.VITE_DEV_SERVER_URL
        ? target.origin === allowedOrigin
        : target.protocol === 'file:';
      if (!isAllowed) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    // No window.open/target=_blank navigation is allowed from the main window.
    // The Discord OAuth popup is created explicitly by the discord-login
    // handler via its own hardened BrowserWindow, not via window.open.
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ─── Window Controls ───
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// ─── Local Config ───
function readLauncherConfig(): LauncherConfig {
  try {
    if (fs.existsSync(LAUNCHER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading launcher config:', e);
  }
  return {};
}

function writeLauncherConfig(config: LauncherConfig) {
  const dir = path.dirname(LAUNCHER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAUNCHER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

ipcMain.handle('get-launcher-config', async () => readLauncherConfig());

ipcMain.handle('save-game-path', async (_event, folderPath) => {
  const check = await validateGamePath(folderPath);
  if (!check.ok) return check;
  launchPreparations.clear();
  const config = readLauncherConfig();
  config.gamePath = folderPath;
  writeLauncherConfig(config);
  return { ok: true, reason: 'ok' };
});

function readWindowsExecutableVersion(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYRP_VERSION_TARGET).FileVersion',
    ], {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, SKYRP_VERSION_TARGET: filePath },
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      const value = String(stdout || '').trim();
      if (!value || value.length > 100) { reject(new Error('Versão inválida.')); return; }
      resolve(value);
    });
  });
}

function validateGamePath(folderPath: string) {
  return inspectSteamSkyrimInstallation(folderPath, { readExecutableVersion: readWindowsExecutableVersion });
}

// ─── Game Path & Validation ───
ipcMain.handle('select-game-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Selecione a pasta do Skyrim (onde está o SkyrimSE.exe)'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('check-game-path', async (_event, folderPath) => {
  return validateGamePath(folderPath);
});

// ─── Skyrim INI Repair ───
function skyrimDocumentsDir() {
  return path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition');
}

function readIniSection(iniPath: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    let inSec = false;
    const hdr = `[${section}]`.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSec = trimmed.toLowerCase() === hdr;
        continue;
      }
      if (!inSec) continue;
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}

function updateIniSection(iniPath: string, section: string, values: Record<string, string | number>) {
  let raw = '';
  try { if (fs.existsSync(iniPath)) raw = fs.readFileSync(iniPath, 'utf8'); } catch {}
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const wanted: Record<string, { key: string; value: string; done: boolean }> = {};
  for (const key of Object.keys(values)) {
    wanted[key.toLowerCase()] = { key, value: String(values[key]), done: false };
  }

  const hdr = `[${section}]`.toLowerCase();
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = trimmed.toLowerCase() === hdr;
      continue;
    }
    if (!inSection) continue;
    const eq = lines[i].indexOf('=');
    if (eq <= 0) continue;
    const key = lines[i].slice(0, eq).trim().toLowerCase();
    if (wanted[key] && !wanted[key].done) {
      lines[i] = `${wanted[key].key}=${wanted[key].value}`;
      wanted[key].done = true;
    }
  }

  const pending = Object.values(wanted).filter((item) => !item.done).map((item) => `${item.key}=${item.value}`);
  if (inSection) {
    const at = sectionEnd === -1 ? lines.length : sectionEnd;
    if (pending.length) lines.splice(at, 0, ...pending);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`, ...Object.values(wanted).map((item) => `${item.key}=${item.value}`));
  }

  const dir = path.dirname(iniPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(iniPath, lines.join('\r\n'));
}

function iniDisplayKeys(width: number, height: number, mode: string) {
  const fullscreen = mode === 'fullscreen' ? 1 : 0;
  const borderless = mode === 'windowed' || mode === 'fullscreen' ? 0 : 1;
  return { 'iSize W': width, 'iSize H': height, 'bFull Screen': fullscreen, 'bBorderless': borderless };
}

ipcMain.handle('ensure-skyrim-ini', async (_event, opts) => {
  try {
    const dir = skyrimDocumentsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prefsPath = path.join(dir, 'SkyrimPrefs.ini');
    const iniPath = path.join(dir, 'Skyrim.ini');

    if (opts?.repairOnly && fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const hasRes = parseInt(display['isize w'], 10) > 0 && parseInt(display['isize h'], 10) > 0;
      const hasMode = 'bborderless' in display || 'bfull screen' in display;
      if (hasRes && hasMode) {
        if (!fs.existsSync(iniPath)) {
          fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
        }
        return { ok: true, skipped: true };
      }
    }

    let width = parseInt(opts?.width, 10);
    let height = parseInt(opts?.height, 10);
    if (!width || !height) {
      try {
        const display = screen.getPrimaryDisplay();
        width = Math.round(display.size.width * display.scaleFactor);
        height = Math.round(display.size.height * display.scaleFactor);
      } catch {}
    }
    if (!width || !height) {
      width = 1920;
      height = 1080;
    }
    const mode = opts?.mode || 'borderless';
    updateIniSection(prefsPath, 'Display', iniDisplayKeys(width, height, mode));
    if (!fs.existsSync(iniPath)) {
      fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
    }

    const config = readLauncherConfig();
    config.display = { width, height, mode };
    writeLauncherConfig(config);
    return { ok: true, width, height, mode };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-display-settings', async () => {
  const result: { displays: Array<{ width: number; height: number }>; current: any } = { displays: [], current: null };
  try {
    const seen = new Set<string>();
    const push = (width: number, height: number) => {
      const key = `${width}x${height}`;
      if (width && height && !seen.has(key)) {
        seen.add(key);
        result.displays.push({ width, height });
      }
    };
    try {
      for (const display of screen.getAllDisplays()) {
        push(Math.round(display.size.width * display.scaleFactor), Math.round(display.size.height * display.scaleFactor));
      }
    } catch {}
    for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1080], [1600, 900], [1366, 768], [1280, 720]]) {
      push(width, height);
    }
    result.displays.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    const prefsPath = path.join(skyrimDocumentsDir(), 'SkyrimPrefs.ini');
    if (fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const width = parseInt(display['isize w'], 10);
      const height = parseInt(display['isize h'], 10);
      const fullscreen = display['bfull screen'] === '1';
      const borderless = display['bborderless'] === '1';
      result.current = { width: width || null, height: height || null, mode: fullscreen ? 'fullscreen' : (borderless ? 'borderless' : 'windowed') };
    }
  } catch (e: any) {
    return { ...result, error: e.message };
  }
  return result;
});

// ─── Auth Flow ───
function readAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading auth file:', e);
  }
  return null;
}

function writeAuthFile(data: any) {
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error writing auth file:', e);
  }
}

function clearAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  } catch {}
}


function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

/**
 * POST de JSON para uma URL arbitrária (http ou https). Diferente de
 * `postJsonToApi`, que é fixo no host/porta do servidor de jogo — o painel web
 * costuma ficar em outro host/porta (VITE_PANEL_URL).
 */
function postJsonToUrl(url: string, body: any): Promise<{ status: number, data: any }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ status: 0, data: null }); return; }

    const transport = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: null }); }
      });
    });

    req.on('error', () => resolve({ status: 0, data: null }));
    req.write(postData);
    req.end();
  });
}

function getGameApiJson(pathname: string, maxBytes = 64 * 1024, timeoutMs = 5000): Promise<{ status: number, data: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number, data: unknown }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request({
      hostname: SERVER_IP,
      port: API_PORT,
      path: pathname,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      let oversized = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (oversized) return;
        data += chunk;
        if (Buffer.byteLength(data) > maxBytes) {
          oversized = true;
          req.destroy();
          finish({ status: res.statusCode || 500, data: null });
        }
      });
      res.on('end', () => {
        if (oversized) return;
        try { finish({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { finish({ status: res.statusCode || 500, data: null }); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ status: 0, data: null });
    });
    req.on('error', () => finish({ status: 0, data: null }));
    req.end();
  });
}

function httpGetJson(url: string, redirectsLeft = 5): Promise<any> {
  return new Promise((resolve) => {
    let trustedUrl: URL;
    try { trustedUrl = assertTrustedUpdateUrl(url); } catch { resolve(null); return; }
    const req = https.get(trustedUrl, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { resolve(null); return; }
        let nextUrl: string;
        try { nextUrl = new URL(res.headers.location, trustedUrl).toString(); }
        catch { resolve(null); return; }
        resolve(httpGetJson(nextUrl, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function downloadToFile(url: string, destPath: string, onProgress?: (percent: number) => void, redirectsLeft = 5, maxBytes?: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let trustedUrl: URL;
    try { trustedUrl = assertTrustedUpdateUrl(url); } catch (error) { reject(error); return; }
    let settled = false;
    let response: import('http').IncomingMessage | null = null;
    let output: fs.WriteStream | null = null;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error('Operação cancelada pelo jogador.');
      response?.destroy(error);
      output?.destroy(error);
      req.destroy(error);
      finish(error);
    };
    const req = https.get(trustedUrl, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      response = res;
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          finish(new Error('Muitos redirecionamentos'));
          return;
        }
        let nextUrl: string;
        try { nextUrl = new URL(res.headers.location, trustedUrl).toString(); }
        catch { finish(new Error('Redirecionamento de atualização inválido.')); return; }
        signal?.removeEventListener('abort', onAbort);
        downloadToFile(nextUrl, destPath, onProgress, redirectsLeft - 1, maxBytes, signal).then(() => finish(), finish);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`HTTP ${res.statusCode} ao baixar arquivo`));
        return;
      }
      const total = parseInt(String(res.headers['content-length'] || '0'), 10);
      if (maxBytes !== undefined && total > maxBytes) {
        res.resume();
        finish(new Error(`Download excede o tamanho assinado (${maxBytes} bytes).`));
        return;
      }
      let received = 0;
      const out = fs.createWriteStream(destPath);
      output = out;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          res.destroy(new Error(`Download excede o tamanho assinado (${maxBytes} bytes).`));
          out.destroy();
          return;
        }
        if (onProgress && total) onProgress(Math.floor((received / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => finish()));
      out.on('error', finish);
      res.on('error', finish);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', finish);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout no download')));
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  // O hash autentica o arquivo recebido, mas não torna seguros os caminhos que
  // existem dentro dele. Toda entrada é validada antes de qualquer escrita.
  const inspection = await inspectArchiveForExtraction(zipPath, destDir);

  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let stderr = '';
    tar.stderr.on('data', data => stderr += data.toString());
    tar.on('error', () => {
      const escape = (value: string) => value.replace(/'/g, "''");
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${escape(zipPath)}' -DestinationPath '${escape(destDir)}' -Force`], { windowsHide: true });
      let psErr = '';
      ps.stderr.on('data', data => psErr += data.toString());
      ps.on('error', reject);
      ps.on('close', code => code === 0 ? resolve() : reject(new Error(psErr || `Expand-Archive saiu com codigo ${code}`)));
    });
    tar.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `tar saiu com codigo ${code}`)));
  });
  return inspection.normalizedNames;
}

function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq SkyrimSE.exe" /NH', { windowsHide: true }, (_err, stdout) => {
      resolve(/SkyrimSE\.exe/i.test(stdout || ''));
    });
  });
}

function killGameProcesses(): Promise<void> {
  return new Promise((resolve) => {
    exec(
      'taskkill /F /T /IM SkyrimSE.exe & taskkill /F /T /IM skse64_loader.exe & ' +
      'taskkill /F /IM "SkyrimPlatformCEF.exe.hidden" & taskkill /F /IM "SkyrimPlatformCEF.exe"',
      { windowsHide: true },
      () => resolve()
    );
  });
}

function readStamp(gamePath: string, filename: string) {
  try {
    const stampPath = path.join(gamePath, filename);
    if (fs.existsSync(stampPath)) return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {}
  return null;
}

function readInstalledModsParts(gamePath: string): Record<string, string | null> {
  try {
    const partsPath = path.join(gamePath, MODS_PARTS_FILENAME);
    if (fs.existsSync(partsPath)) return JSON.parse(fs.readFileSync(partsPath, 'utf8')) || {};
  } catch {}
  return {};
}

type InstalledPartState = string | null | { contentSig: string | null; files: string[] };

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {}
  return fallback;
}

function readManagedFiles(gamePath: string, filename: string): string[] {
  const value = readJsonFile<unknown>(path.join(gamePath, filename), []);
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function installedPartSignature(value: InstalledPartState) {
  return value && typeof value === 'object' ? value.contentSig : value;
}

function installedPartFiles(value: InstalledPartState) {
  return value && typeof value === 'object' && Array.isArray(value.files) ? value.files : [];
}

function assertPayloadDoesNotOwnLauncherState(files: string[]) {
  for (const file of files) {
    if (RESERVED_UPDATE_FILES.has(file.toLocaleLowerCase('en-US'))) {
      throw new Error(`O pacote tentou sobrescrever estado reservado do launcher: ${file}`);
    }
  }
}

function regularStagedFiles(stagingRoot: string, candidates: string[]) {
  return candidates.filter(relativePath => {
    try { return fs.lstatSync(path.join(stagingRoot, ...relativePath.split('/'))).isFile(); }
    catch { return false; }
  });
}

function writeStagedText(transaction: InstallTransaction, filename: string, content: string) {
  fs.writeFileSync(path.join(transaction.stagingRoot, filename), content);
}

function obsoleteManagedFiles(previous: string[], next: string[]) {
  const nextKeys = new Set(next.map(value => value.toLocaleLowerCase('en-US')));
  return previous.filter(value => !nextKeys.has(value.toLocaleLowerCase('en-US')));
}

function clientManifestUrl() {
  return githubFeedUrl(DIST_REPO, 'client', CLIENT_UPDATE_CHANNEL);
}

function modsManifestUrl() {
  return githubFeedUrl(DIST_REPO, 'mods', MODS_UPDATE_CHANNEL);
}

type UpdateKind = 'client' | 'mods';

function releaseFilename(kind: UpdateKind) {
  return kind === 'client' ? CLIENT_RELEASE_FILENAME : MODS_RELEASE_FILENAME;
}

function verifyUpdateEnvelope(envelope: unknown, kind: UpdateKind, gamePath?: string) {
  const channel = kind === 'client' ? CLIENT_UPDATE_CHANNEL : MODS_UPDATE_CHANNEL;
  const rememberedReleases = readRememberedReleases(UPDATE_SECURITY_FILE);
  const remembered = chooseHighestRelease(...rememberedReleaseCandidates(rememberedReleases, kind, channel));
  const installed = installedReleaseForChannel(
    gamePath ? readInstalledRelease(gamePath, releaseFilename(kind)) : null,
    channel,
  );
  const verified = verifySignedUpdateEnvelope(envelope, {
    kind,
    publicKeys: UPDATE_PUBLIC_KEYS,
    rememberedRelease: remembered,
    installedRelease: installed,
  });
  assertPayloadChannel(verified.payload, channel, kind);
  return { ...verified, release: releaseForChannel(verified.release, channel) };
}

function acceptUpdateRelease(kind: UpdateKind, release: unknown) {
  const channel = kind === 'client' ? CLIENT_UPDATE_CHANNEL : MODS_UPDATE_CHANNEL;
  return rememberAcceptedRelease(UPDATE_SECURITY_FILE, releaseStateKey(kind, channel), release);
}

function crashlogDirs() {
  const skseDir = path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition', 'SKSE');
  return [skseDir, path.join(skseDir, 'Crashlogs')];
}

function collectRecentCrashLogs(limit = 2) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const files: Array<{ name: string; fullPath: string; mtime: number }> = [];
  for (const dir of crashlogDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!/^crash-.*\.(log|txt)$/i.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile() || stat.mtimeMs < since) continue;
      files.push({ name: entry, fullPath, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function postJsonToApi(pathname: string, body: any): Promise<any> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: SERVER_IP,
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: res.statusCode && res.statusCode < 300, status: res.statusCode }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('discord-login', async () => {
  return new Promise((resolve) => {
    const oauthState = crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const callbackServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost:19847');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (!state || state !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro: parâmetro state inválido ou ausente.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro: código de autorização não recebido.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        // A troca de `code` por token roda no painel web, não aqui: o client
        // secret do Discord não pode viajar dentro de um instalador que os
        // jogadores baixam. Ver POST /api/launcher/oauth/exchange em
        // apps/web/server.js e docs/technical/LAUNCHER_DISTRIBUTION.md.
        const exchange = await postJsonToUrl(`${PANEL_URL}/api/launcher/oauth/exchange`, {
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        });

        if (exchange.status !== 200 || !exchange.data || !exchange.data.discordId) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro ao concluir o login. Verifique se o painel do servidor está acessível.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        const user = exchange.data;
        const authData = {
          discordId: user.discordId,
          username: user.username,
          globalName: user.globalName || user.username,
          avatar: user.avatar || null,
          // Prova de que este Discord autenticou de fato, emitida pelo painel.
          // É o que a fila (apps/game-api) exige — `discordId` sozinho é público
          // e não prova nada. Vem ausente se a conta ainda não existe no painel
          // (jogador que nunca pediu whitelist).
          launchTicket: user.launchTicket || null,
          loginDate: new Date().toISOString(),
        };

        writeAuthFile(authData);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#c9a227;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;">
                <h1>✅ Login realizado com sucesso!</h1>
                <p style="color:#d6d3d1;">Bem-vindo, ${escapeHtml(authData.globalName)}! Pode fechar esta janela.</p>
              </div>
            </body>
          </html>
        `);

        callbackServer.close();
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
        finish(authData);
      } catch (err) {
        console.error('OAuth2 callback error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Erro interno.</h1>');
        callbackServer.close();
        finish(null);
      }
    });

    callbackServer.listen(19847, '127.0.0.1', () => {
      console.log('OAuth2 callback server listening on 127.0.0.1:19847');
    });

    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&scope=identify%20connections&state=${oauthState}`;

    let authWindow: BrowserWindow | null = new BrowserWindow({
      width: 500,
      height: 750,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      title: 'Entrar com Discord',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        // No preload script: this window only performs the Discord OAuth
        // flow and must never get access to electronAPI.
      }
    });

    authWindow.setMenuBarVisibility(false);
    authWindow.loadURL(authUrl);

    authWindow.on('closed', () => {
      authWindow = null;
      callbackServer.close(() => {});
      // If the window was closed before the OAuth callback fired, don't leave
      // the caller hanging until the 5 minute timeout below.
      finish(null);
    });

    setTimeout(() => {
      callbackServer.close(() => {});
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      finish(null);
    }, 5 * 60 * 1000);
  });
});

ipcMain.handle('discord-logout', async () => {
  launchPreparations.clear();
  currentQueueTicket = null;
  clearAuthFile();
  return true;
});

ipcMain.handle('get-auth-status', async () => {
  const auth = readAuthFile();
  if (!auth || !auth.discordId) return null;
  return {
    discordId: auth.discordId,
    username: auth.username,
    globalName: auth.globalName,
    avatar: auth.avatar,
    loginDate: auth.loginDate,
  };
});

ipcMain.handle('get-server-status', async () => {
  const response = await getGameApiJson('/status');
  if (response.status !== 200) return offlineServerStatus();
  return normalizeServerStatus(response.data);
});

// ─── Queue System ───
//
// A fila é autenticada por ticket, não por `discordId`: discordId é público, e
// mandá-lo como prova de identidade deixaria qualquer um entrar na fila no
// lugar de outro jogador. O ticket inicial vem do painel no login; cada consulta
// consome o ticket atual e recebe o próximo (`pollTicket`), então um ticket
// interceptado já está gasto quando chega em outras mãos.

/**
 * Guarda o ticket da próxima consulta de fila. Vive só em memória de propósito:
 * é de uso único e curto, não faz sentido persistir entre execuções.
 */
let currentQueueTicket: string | null = null;

function validateQueuePreparation(preparationToken: string, gamePath: string) {
  const auth = readAuthFile();
  if (!auth?.discordId || !gamePath) return false;
  return launchPreparations.validate(preparationToken, {
    gamePath: launchPathIdentity(gamePath),
    discordId: String(auth.discordId),
  }).ok;
}

function nextQueueTicket(): string | null {
  const auth = readAuthFile();
  return currentQueueTicket || (auth && auth.launchTicket) || null;
}

function rememberQueueTicket(response: any) {
  if (response && typeof response.pollTicket === 'string') {
    currentQueueTicket = response.pollTicket;
    delete response.pollTicket; // o renderer não precisa nem deve ver o ticket
  }
  return response;
}

ipcMain.handle('join-queue', async (_event, preparationToken, gamePath) => {
  if (!validateQueuePreparation(preparationToken, gamePath)) {
    return { status: 'error', message: 'preparation_required' };
  }
  const ticket = nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/join`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// O ticket vai no corpo do POST, igual ao `join-queue` acima. Já foi query
// string de um GET: query string entra em log de acesso e de proxy, e o ticket
// é credencial — quem o tem consulta a fila como aquela conta. Ver
// `SEC-QS-01` em docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md.
ipcMain.handle('poll-queue', async (_event, preparationToken, gamePath) => {
  if (!validateQueuePreparation(preparationToken, gamePath)) {
    return { status: 'error', message: 'preparation_required' };
  }
  const ticket = nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/status`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// ─── Mod Manager ───
function listDataPlugins(folderPath: string) {
  const dataPath = path.join(folderPath, 'Data');
  if (!fs.existsSync(dataPath)) return [];
  return fs.readdirSync(dataPath).filter(file =>
    file.toLowerCase().endsWith('.esp') ||
    file.toLowerCase().endsWith('.esl') ||
    file.toLowerCase().endsWith('.esm')
  );
}

function readPluginHeader(filePath: string): PluginHeader {
  // O I/O fica aqui; o parsing vive em parity.mjs, testado com plugin
  // sintetico. Lemos so o comeco do arquivo: o bloco de masters fica no
  // cabecalho, e um .esm de Skyrim tem centenas de MB.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.length >= 8) {
      const dataSize = head.readUInt32LE(4);
      const cap = Math.min(dataSize, 1024 * 1024);
      const corpo = Buffer.alloc(cap);
      fs.readSync(fd, corpo, 0, cap, 24);
      return parsePluginHeader(Buffer.concat([head, corpo]));
    }
    return parsePluginHeader(head);
  } catch (e: any) {
    return { masters: [], isMaster: false, isLight: false, error: e.message };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

ipcMain.handle('get-local-plugins', async (_event, folderPath) => {
  if (!folderPath) return { plugins: [], pluginsTxt: [] };
  try {
    const plugins = listDataPlugins(folderPath);
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtPath = path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
    const pluginsTxt = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8'))
      : [];
    return { plugins, pluginsTxt };
  } catch {
    return { plugins: [], pluginsTxt: [] };
  }
});

async function verifyModsForGame(folderPath: string) {
  if (!folderPath) return { success: false, error: "Caminho do jogo inválido." };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { success: false, error: "Pasta Data não encontrada." };

    const response = await getGameApiJson('/mods.json', 16 * 1024 * 1024, 20_000);
    if (response.status !== 200 || !response.data) {
      return { success: false, error: "Falha ao baixar mods.json do servidor. Servidor pode estar offline." };
    }
    const rememberedReleases = readRememberedReleases(UPDATE_SECURITY_FILE);
    const remembered = chooseHighestRelease(
      ...rememberedReleaseCandidates(rememberedReleases, 'parity', MODS_UPDATE_CHANNEL),
    );
    const verified = verifySignedUpdateEnvelope(response.data, {
      kind: 'parity', publicKeys: UPDATE_PUBLIC_KEYS, rememberedRelease: remembered,
    });
    assertPayloadChannel(verified.payload, MODS_UPDATE_CHANNEL, 'parity');
    rememberAcceptedRelease(
      UPDATE_SECURITY_FILE,
      releaseStateKey('parity', MODS_UPDATE_CHANNEL),
      releaseForChannel(verified.release, MODS_UPDATE_CHANNEL),
    );
    const modsJson: any = verified.payload;
    const manifestContractResult = validateModsManifestContract(modsJson);
    if (!manifestContractResult.ok) {
      return {
        success: false,
        error: `Manifesto de mods incompatível: ${manifestContractResult.reason}. Atualize o launcher.`
      };
    }

    const problems: string[] = [];
    const known: string[] = [];
    for (const file of modsJson.files) {
      const key = String(file.path).toLocaleLowerCase('en-US');
      known.push(key);
      const components = String(file.path).split('/');
      const target = path.join(folderPath, ...components);
      let stat;
      try {
        let ancestor = folderPath;
        for (const component of components.slice(0, -1)) {
          ancestor = path.join(ancestor, component);
          if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('linked-ancestor');
        }
        stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          problems.push(`Destino inválido ou link recusado: ${file.path}`);
          continue;
        }
      } catch {
        if (file.required) problems.push(`Arquivo ausente: ${file.path}`);
        continue;
      }
      if (stat.size !== file.size) {
        problems.push(`Tamanho divergente: ${file.path}`);
        continue;
      }
      const actual = await sha256File(target);
      if (actual.toLocaleLowerCase('en-US') !== file.sha256) problems.push(`SHA-256 divergente: ${file.path}`);
    }

    const extras: string[] = [];
    const tree = inspectDataTree(dataPath);
    problems.push(...tree.links.map(file => `Link inesperado na Data: ${file}`));
    extras.push(...findUnexpectedDataFiles(tree.files, known, modsJson.ignoredPaths || []));
    if (modsJson.extraFilePolicy === 'reject') problems.push(...extras.map(file => `Arquivo extra recusado: ${file}`));
    const warnings = modsJson.extraFilePolicy === 'warn' ? extras.map(file => `Arquivo extra: ${file}`) : [];
    if (problems.length) return { success: false, problems, manifest: modsJson, release: verified.release };
    return { success: true, loadOrder: modsJson.loadOrder, warnings, manifest: modsJson, release: verified.release };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

ipcMain.handle('verify-mods', async (_event, folderPath) => {
  const result = await verifyModsForGame(folderPath);
  const { manifest: _manifest, release: _release, ...publicResult } = result as any;
  return publicResult;
});

async function analyzePluginsForGame(folderPath: string, serverLoadOrder: string[]) {
  if (!folderPath) return { ok: false, problems: ['Caminho do jogo invalido.'], plugins: [] };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { ok: false, problems: ['Pasta Data nao encontrada.'], plugins: [] };

    // A load order real vem do plugins.txt, nao dos arquivos presentes em
    // Data/: um plugin no disco e desativado nao ocupa indice e nao desloca
    // FormID nenhum. Sem o arquivo, parity.mjs cai para os arquivos presentes,
    // que e a direcao segura.
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtPath = path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
    const enabledPlugins = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8')).filter(p => p.enabled).map(p => p.name)
      : undefined;

    const localPlugins = listDataPlugins(folderPath);

    const resultado = analyzePlugins({
      localPlugins,
      serverLoadOrder,
      enabledPlugins,
      readHeader: (nome: string) => readPluginHeader(path.join(dataPath, nome))
    });

    // Creation Club nao passa pelo plugins.txt: o Skyrim AE le o Skyrim.ccc e
    // carrega sozinho o que estiver listado e presente em Data/. Sao plugins
    // que ocupam indice de load order e que a checagem acima nao enxerga.
    //
    // O arquivo fica na raiz do jogo, ao lado do executavel — nao em Data/. E
    // o conteudo dele varia conforme o que a conta Steam possui, entao dois
    // testadores podem carregar listas diferentes sem ter escolhido nada.
    const cccPath = path.join(folderPath, 'Skyrim.ccc');
    const cccEntries = fs.existsSync(cccPath)
      ? parseCccTxt(fs.readFileSync(cccPath, 'utf8'))
      : [];

    const cc = analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder });

    return {
      ...resultado,
      ok: resultado.ok && cc.ok,
      problems: [...resultado.problems, ...cc.problems],
      creationClub: cc.effective
    };
  } catch (e: any) {
    return { ok: false, problems: [e.message], plugins: [] };
  }
}

ipcMain.handle('analyze-plugins', async (_event, folderPath, serverLoadOrder) => analyzePluginsForGame(folderPath, serverLoadOrder));

async function syncLoadOrderForGame(folderPath: string, serverLoadOrder: string[]) {
  if (!folderPath || !Array.isArray(serverLoadOrder)) return false;
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return false;

    const allFiles = fs.readdirSync(dataPath);
    const diskPlugins = allFiles.filter(f => f.toLowerCase().endsWith('.esp') || f.toLowerCase().endsWith('.esl') || f.toLowerCase().endsWith('.esm'));

    const resultLines = [
      '# This file is managed by Skyrim Heavy RP Launcher.',
      '# Do not modify manually.'
    ];

    for (const plugin of serverLoadOrder) {
      const match = diskPlugins.find(p => p.toLowerCase() === plugin.toLowerCase());
      if (match) resultLines.push('*' + match);
    }

    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtDir = path.join(localAppData, 'Skyrim Special Edition');
    if (!fs.existsSync(pluginsTxtDir)) fs.mkdirSync(pluginsTxtDir, { recursive: true });

    fs.writeFileSync(path.join(pluginsTxtDir, 'plugins.txt'), resultLines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('sync-loadorder', async (_event, folderPath, serverLoadOrder) => syncLoadOrderForGame(folderPath, serverLoadOrder));

ipcMain.handle('is-game-running', async () => isGameRunning());

ipcMain.handle('kill-game', async () => {
  await killGameProcesses();
  return true;
});

async function checkClientUpdateForGame(gamePath?: string) {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  try {
    const envelope = await httpGetJson(clientManifestUrl());
    if (!envelope) return { updateAvailable: false, error: 'Manifesto de cliente indisponivel.' };
    const verified = verifyUpdateEnvelope(envelope, 'client', gamePath);
    const manifest = verified.payload as any;
    if (!manifest.clientVersion) return { updateAvailable: false, error: 'Payload assinado do cliente e invalido.' };
    acceptUpdateRelease('client', verified.release);
    const installedVersion = gamePath ? readStamp(gamePath, CLIENT_VERSION_FILENAME) : null;
    return {
      updateAvailable: installedVersion !== manifest.clientVersion,
      installedVersion,
      version: manifest.clientVersion,
      sequence: verified.release.sequence,
      notes: manifest.notes || '',
      sizeBytes: manifest.sizeBytes || 0
    };
  } catch (e: any) {
    return { updateAvailable: false, error: e.message };
  }
}

ipcMain.handle('check-client-update', async (_event, gamePath) => checkClientUpdateForGame(gamePath));

ipcMain.handle('install-client-update', async (_event, gamePath) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  const gameCheck = await validateGamePath(gamePath);
  if (!gameCheck.ok) return { success: false, error: gameCheck.message || 'Somente Skyrim Steam 1.6.1170.0 é aceito.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  if (updateOperations.busy) return { success: false, error: 'Ja existe uma atualizacao em andamento.' };
  const operation = updateOperations.begin('client-update')!;
  launchPreparations.clear();

  const send = (phase: string, percent: number) => {
    if (['download', 'verify', 'extract', 'commit'].includes(phase)) updateOperations.setPhase(operation, phase as any);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', { phase, percent });
  };
  let transaction: InstallTransaction | null = null;
  let tmpZip = '';
  try {
    const envelope = await httpGetJson(clientManifestUrl());
    if (!envelope) return { success: false, error: 'Manifesto de cliente indisponivel.' };
    const verified = verifyUpdateEnvelope(envelope, 'client', gamePath);
    const manifest = verified.payload as any;
    if (!manifest.downloadUrl || !manifest.clientVersion) return { success: false, error: 'Payload assinado do cliente e invalido.' };
    acceptUpdateRelease('client', verified.release);
    transaction = await createInstallTransaction(gamePath);
    tmpZip = path.join(transaction.activeRoot, 'client-update.zip');
    send('download', 0);
    await downloadToFile(manifest.downloadUrl, tmpZip, percent => send('download', percent), 5, manifest.sizeBytes, operation.signal);
    throwIfUpdateCancelled(operation.signal);
    if (!manifest.sha256) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'Manifesto de cliente sem SHA256: verificacao de integridade obrigatoria ausente.' };
    }
    send('verify', 0);
    const actual = await sha256File(tmpZip);
    throwIfUpdateCancelled(operation.signal);
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'SHA256 do cliente nao confere.' };
    }
    send('verify', 100);
    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));
    send('extract', 0);
    const archiveEntries = await extractZip(tmpZip, transaction.stagingRoot);
    throwIfUpdateCancelled(operation.signal);
    const clientFiles = regularStagedFiles(transaction.stagingRoot, archiveEntries);
    assertPayloadDoesNotOwnLauncherState(clientFiles);
    const modsFiles = Object.values(readInstalledModsParts(gamePath) as Record<string, InstalledPartState>)
      .flatMap(installedPartFiles);
    const modsKeys = new Set(modsFiles.map(value => value.toLocaleLowerCase('en-US')));
    const collision = clientFiles.find(value => modsKeys.has(value.toLocaleLowerCase('en-US')));
    if (collision) throw new Error(`Arquivo pertence ao pacote de mods e ao cliente: ${collision}`);
    const previousFiles = readManagedFiles(gamePath, CLIENT_FILES_FILENAME);
    writeStagedText(transaction, CLIENT_FILES_FILENAME, `${JSON.stringify(clientFiles.sort(), null, 2)}\n`);
    writeStagedText(transaction, CLIENT_VERSION_FILENAME, String(manifest.clientVersion).trim());
    writeStagedText(transaction, CLIENT_RELEASE_FILENAME, serializeReleaseState(verified.release));
    try { fs.unlinkSync(tmpZip); } catch {}
    send('commit', 0);
    const committed = await commitInstallTransaction(
      transaction,
      [...clientFiles, CLIENT_FILES_FILENAME, CLIENT_VERSION_FILENAME, CLIENT_RELEASE_FILENAME],
      obsoleteManagedFiles(previousFiles, clientFiles),
    );
    send('extract', 100);
    send('commit', 100);
    return { success: true, version: manifest.clientVersion, transactionId: committed.transactionId };
  } catch (e: any) {
    if (tmpZip) try { fs.unlinkSync(tmpZip); } catch {}
    if (transaction) try { await discardInstallTransaction(transaction); } catch {}
    return { success: false, cancelled: operation.signal.aborted, error: e.message };
  } finally {
    updateOperations.finish(operation);
  }
});

async function checkModsUpdateForGame(gamePath?: string) {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  try {
    const envelope = await httpGetJson(modsManifestUrl());
    if (!envelope) return { updateAvailable: false, error: 'Manifesto de mods indisponivel.' };
    const verified = verifyUpdateEnvelope(envelope, 'mods', gamePath);
    const manifest = verified.payload as any;
    if (!manifest.modsVersion) return { updateAvailable: false, error: 'Payload assinado de mods e invalido.' };
    acceptUpdateRelease('mods', verified.release);
    const installedVersion = gamePath ? readStamp(gamePath, MODS_VERSION_FILENAME) : null;
    return {
      updateAvailable: installedVersion !== manifest.modsVersion,
      installedVersion,
      version: manifest.modsVersion,
      sequence: verified.release.sequence,
      notes: manifest.notes || '',
      mandatory: !!manifest.mandatory,
      sizeBytes: manifest.sizeBytes || 0
    };
  } catch (e: any) {
    return { updateAvailable: false, error: e.message };
  }
}

ipcMain.handle('check-mods-update', async (_event, gamePath) => checkModsUpdateForGame(gamePath));

function launchPathIdentity(folderPath: string) {
  let resolved = path.resolve(folderPath);
  try { resolved = fs.realpathSync.native(resolved); } catch {}
  return path.normalize(resolved).toLocaleLowerCase('en-US');
}

async function prepareToPlay(gamePath: string) {
  launchPreparations.clear();
  const auth = readAuthFile();
  if (!auth?.discordId) {
    return { status: 'blocked', code: 'NOT_AUTHENTICATED', action: 'retry', message: 'Faça login novamente antes de jogar.' };
  }
  const pathCheck = await validateGamePath(gamePath);
  if (!pathCheck.ok) {
    return { status: 'blocked', code: 'GAME_PATH_INVALID', action: 'settings', message: pathCheck.message || `Pasta do jogo inválida: ${pathCheck.reason}.` };
  }
  if (!fs.existsSync(path.join(gamePath, 'skse64_loader.exe'))) {
    return { status: 'blocked', code: 'CLIENT_INVALID', action: 'update-client', message: 'Cliente SkyMP/SKSE ausente ou incompleto. Reinstale o cliente.' };
  }
  if (await isGameRunning()) {
    return { status: 'blocked', code: 'GAME_ALREADY_RUNNING', action: 'retry', message: 'O Skyrim já está aberto.' };
  }

  // Desenvolvimento local sem repo de distribuição pode exercitar a Fase 0.
  // Um app empacotado nunca recebe esse bypass: sem feed/chave ele falha
  // fechado, porque não há como provar que cliente e modpack estão atuais.
  const localDevelopment = !app.isPackaged && !DIST_REPO;
  const clientUpdate = localDevelopment
    ? { updateAvailable: false, installedVersion: readStamp(gamePath, CLIENT_VERSION_FILENAME) }
    : await checkClientUpdateForGame(gamePath);
  const modsUpdate = localDevelopment
    ? { updateAvailable: false, installedVersion: readStamp(gamePath, MODS_VERSION_FILENAME) }
    : await checkModsUpdateForGame(gamePath);
  const updates = classifyUpdateReadiness(clientUpdate, modsUpdate);
  if (updates.status !== 'continue') return updates;

  const verification = await verifyModsForGame(gamePath);
  if (!verification.success) {
    const parity = classifyParityReadiness(verification, null);
    return { ...parity, problems: parity.problems?.slice(0, 50) || [] };
  }
  const loadOrder = 'loadOrder' in verification && Array.isArray(verification.loadOrder)
    ? verification.loadOrder as string[]
    : [];
  if (loadOrder.length === 0) {
    return { status: 'blocked', code: 'LOAD_ORDER_MISSING', action: 'retry', message: 'O servidor não publicou uma load order válida.' };
  }
  if (!await syncLoadOrderForGame(gamePath, loadOrder)) {
    return { status: 'blocked', code: 'LOAD_ORDER_WRITE_FAILED', action: 'settings', message: 'Não foi possível gravar plugins.txt. Verifique permissões da pasta.' };
  }
  const analysis = await analyzePluginsForGame(gamePath, loadOrder);
  const parity = classifyParityReadiness(verification, analysis);
  if (parity.status !== 'ready') return { ...parity, problems: parity.problems?.slice(0, 50) || [] };

  const receipt = launchPreparations.issue({
    gamePath: launchPathIdentity(gamePath),
    discordId: String(auth.discordId),
  });
  return {
    status: 'ready',
    preparationToken: receipt.token,
    expiresAt: new Date(receipt.expiresAt).toISOString(),
    clientVersion: clientUpdate.installedVersion,
    modsVersion: modsUpdate.installedVersion,
  };
}

ipcMain.handle('prepare-to-play', async (_event, gamePath) => prepareToPlay(gamePath));

const REPAIR_CONFIRMATION_BYTES = 500 * 1024 * 1024;

ipcMain.handle('repair-mods-incremental', async (_event, gamePath, confirmed) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo inválido.' };
  const gameCheck = await validateGamePath(gamePath);
  if (!gameCheck.ok) return { success: false, error: gameCheck.message || 'Somente Skyrim Steam 1.6.1170.0 é aceito.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo está aberto. Feche antes de reparar.' };
  if (updateOperations.busy) return { success: false, error: 'Já existe uma atualização em andamento.' };

  const verification = await verifyModsForGame(gamePath);
  if (verification.success) return { success: true, alreadyValid: true, repaired: 0 };
  const manifest = 'manifest' in verification ? verification.manifest : null;
  if (!manifest) return { success: false, error: verification.error || 'Manifesto assinado indisponível.' };
  const plan = await inspectManifestForRepair(gamePath, manifest);
  if (plan.unsafe.length) {
    return { success: false, error: 'Repair recusado porque um destino atravessa link ou tipo inseguro.', unsafeFiles: plan.unsafe.map(file => file.path) };
  }
  if (plan.manual.length) {
    return {
      success: false,
      error: 'Há arquivos divergentes sem autorização de redistribuição. Instale-os manualmente e tente novamente.',
      manualFiles: plan.manual.map(file => file.path),
    };
  }
  const unrepairable = (verification.problems || []).filter(problem => /^Arquivo extra recusado:|^Link inesperado/.test(problem));
  if (unrepairable.length) {
    return { success: false, error: 'Existem arquivos extras que não podem ser removidos automaticamente.', problems: unrepairable };
  }
  if (plan.repairable.length === 0) {
    return { success: false, error: 'Nenhum arquivo redistribuível pode corrigir as divergências encontradas.', problems: verification.problems || [] };
  }
  if (!confirmed && plan.downloadBytes > REPAIR_CONFIRMATION_BYTES) {
    return {
      success: false, confirmationRequired: true, downloadBytes: plan.downloadBytes,
      files: plan.repairable.map(file => file.path),
    };
  }

  const operation = updateOperations.begin('mods-repair');
  if (!operation) return { success: false, error: 'Já existe uma atualização em andamento.' };
  launchPreparations.clear();
  let transaction: InstallTransaction | null = null;
  const send = (phase: string, percent: number) => {
    if (phase === 'repair-download') updateOperations.setPhase(operation, 'download');
    if (phase === 'repair-commit') updateOperations.setPhase(operation, 'commit');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-update-progress', { phase, percent });
  };
  try {
    transaction = await createInstallTransaction(gamePath);
    let completedBytes = 0;
    for (const file of plan.repairable) {
      const staged = path.join(transaction.stagingRoot, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(staged), { recursive: true });
      await downloadToFile(file.downloadUrl!, staged, partPercent => {
        const partial = file.size * partPercent / 100;
        send('repair-download', Math.floor(((completedBytes + partial) / plan.downloadBytes) * 100));
      }, 5, file.size, operation.signal);
      throwIfUpdateCancelled(operation.signal);
      updateOperations.setPhase(operation, 'verify');
      const stat = fs.lstatSync(staged);
      if (!stat.isFile() || stat.size !== file.size) throw new Error(`Tamanho do repair não confere: ${file.path}`);
      if ((await sha256File(staged)).toLocaleLowerCase('en-US') !== file.sha256) throw new Error(`SHA-256 do repair não confere: ${file.path}`);
      throwIfUpdateCancelled(operation.signal);
      completedBytes += file.size;
    }
    send('repair-commit', 0);
    const committed = await commitInstallTransaction(transaction, plan.repairable.map(file => file.path));
    transaction = null;
    const finalCheck = await verifyModsForGame(gamePath);
    if (!finalCheck.success) {
      await rollbackLastInstall(gamePath);
      return { success: false, error: 'Validação final falhou; o repair foi revertido.', problems: finalCheck.problems || [] };
    }
    send('repair-commit', 100);
    return {
      success: true, repaired: plan.repairable.length, downloadedBytes: plan.downloadBytes,
      transactionId: committed.transactionId,
    };
  } catch (error: any) {
    if (transaction) try { await discardInstallTransaction(transaction); } catch {}
    return { success: false, cancelled: operation.signal.aborted, error: error.message };
  } finally {
    updateOperations.finish(operation);
  }
});

ipcMain.handle('install-mods-update', async (_event, gamePath, force) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  const gameCheck = await validateGamePath(gamePath);
  if (!gameCheck.ok) return { success: false, error: gameCheck.message || 'Somente Skyrim Steam 1.6.1170.0 é aceito.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar mods.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  if (updateOperations.busy) return { success: false, error: 'Ja existe uma atualizacao em andamento.' };
  const operation = updateOperations.begin('mods-update')!;
  launchPreparations.clear();

  const send = (phase: string, percent: number) => {
    if (['download', 'verify', 'extract', 'commit'].includes(phase)) updateOperations.setPhase(operation, phase as any);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-update-progress', { phase, percent });
  };
  let transaction: InstallTransaction | null = null;
  let tmpZip = '';
  try {
    const envelope = await httpGetJson(modsManifestUrl());
    if (!envelope) return { success: false, error: 'Manifesto de mods indisponivel.' };
    const verified = verifyUpdateEnvelope(envelope, 'mods', gamePath);
    const manifest = verified.payload as any;
    if (!manifest.modsVersion || (!manifest.downloadUrl && !Array.isArray(manifest.parts))) return { success: false, error: 'Payload assinado de mods e invalido.' };
    acceptUpdateRelease('mods', verified.release);
    const installedVersion = readStamp(gamePath, MODS_VERSION_FILENAME);
    if (!force && installedVersion === manifest.modsVersion) {
      return { success: true, version: manifest.modsVersion, alreadyCurrent: true };
    }

    const parts = Array.isArray(manifest.parts) && manifest.parts.length > 0
      ? manifest.parts
      : [{ url: manifest.downloadUrl, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, contentSig: manifest.contentSig, name: 'single' }];
    const installedParts = readInstalledModsParts(gamePath) as Record<string, InstalledPartState>;
    const finalParts: Record<string, { contentSig: string | null; files: string[] }> = {};
    const previousFiles = Object.values(installedParts).flatMap(installedPartFiles);
    const finalFiles = new Set<string>();
    const downloadedFiles: string[] = [];
    transaction = await createInstallTransaction(gamePath);
    tmpZip = path.join(transaction.activeRoot, 'mods-update.zip');

    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));

    let downloaded = 0;
    let skipped = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const partKey = part.name || part.url;
      const base = Math.round((index / parts.length) * 100);
      const span = Math.max(1, Math.round(100 / parts.length));
      const previousPart = installedParts[partKey];
      const previousPartFiles = installedPartFiles(previousPart);
      if (!force && part.contentSig && installedPartSignature(previousPart) === part.contentSig && previousPartFiles.length > 0) {
        skipped += 1;
        finalParts[partKey] = { contentSig: part.contentSig, files: previousPartFiles };
        for (const file of previousPartFiles) finalFiles.add(file);
        send('extract', Math.min(100, base + span));
        continue;
      }
      downloaded += 1;
      send('download', base);
      await downloadToFile(part.url, tmpZip, percent => send('download', Math.min(100, base + Math.round(percent * span / 100))), 5, part.sizeBytes, operation.signal);
      throwIfUpdateCancelled(operation.signal);
      if (!part.sha256) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `Parte ${index + 1} sem SHA256: verificacao de integridade obrigatoria ausente.` };
      }
      send('verify', base);
      const actual = await sha256File(tmpZip);
      throwIfUpdateCancelled(operation.signal);
      if (actual.toLowerCase() !== String(part.sha256).toLowerCase()) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `SHA256 dos mods nao confere na parte ${index + 1}.` };
      }
      send('extract', base);
      const archiveEntries = await extractZip(tmpZip, transaction.stagingRoot);
      throwIfUpdateCancelled(operation.signal);
      const partFiles = regularStagedFiles(transaction.stagingRoot, archiveEntries);
      assertPayloadDoesNotOwnLauncherState(partFiles);
      for (const file of partFiles) {
        const key = file.toLocaleLowerCase('en-US');
        const duplicate = [...finalFiles].some(existing => existing.toLocaleLowerCase('en-US') === key);
        if (duplicate) throw new Error(`Duas partes do modpack escrevem o mesmo arquivo: ${file}`);
        finalFiles.add(file);
        downloadedFiles.push(file);
      }
      finalParts[partKey] = { contentSig: part.contentSig || null, files: partFiles };
      try { fs.unlinkSync(tmpZip); } catch {}
    }

    const clientKeys = new Set(readManagedFiles(gamePath, CLIENT_FILES_FILENAME).map(value => value.toLocaleLowerCase('en-US')));
    const collision = [...finalFiles].find(value => clientKeys.has(value.toLocaleLowerCase('en-US')));
    if (collision) throw new Error(`Arquivo pertence ao pacote de cliente e aos mods: ${collision}`);
    writeStagedText(transaction, MODS_PARTS_FILENAME, `${JSON.stringify(finalParts, null, 2)}\n`);
    writeStagedText(transaction, MODS_VERSION_FILENAME, String(manifest.modsVersion).trim());
    writeStagedText(transaction, MODS_RELEASE_FILENAME, serializeReleaseState(verified.release));
    send('commit', 0);
    const committed = await commitInstallTransaction(
      transaction,
      [...downloadedFiles, MODS_PARTS_FILENAME, MODS_VERSION_FILENAME, MODS_RELEASE_FILENAME],
      obsoleteManagedFiles(previousFiles, [...finalFiles]),
    );
    send('extract', 100);
    send('commit', 100);
    return { success: true, version: manifest.modsVersion, downloaded, skipped, transactionId: committed.transactionId };
  } catch (e: any) {
    if (tmpZip) try { fs.unlinkSync(tmpZip); } catch {}
    if (transaction) try { await discardInstallTransaction(transaction); } catch {}
    return { success: false, cancelled: operation.signal.aborted, error: e.message };
  } finally {
    updateOperations.finish(operation);
  }
});

ipcMain.handle('cancel-update-operation', async () => updateOperations.cancel());

ipcMain.handle('rollback-last-update', async (_event, gamePath) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  const gameCheck = await validateGamePath(gamePath);
  if (!gameCheck.ok) return { success: false, error: gameCheck.message || 'Somente Skyrim Steam 1.6.1170.0 é aceito.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes do rollback.' };
  if (updateOperations.busy) return { success: false, error: 'Ja existe uma atualizacao em andamento.' };
  const operation = updateOperations.begin('rollback')!;
  updateOperations.setPhase(operation, 'commit');
  launchPreparations.clear();
  let transaction: InstallTransaction | null = null;
  try {
    transaction = await createInstallTransaction(gamePath);
    const result = await rollbackLastInstall(gamePath);
    return result.rolledBack
      ? { success: true, transactionId: result.transactionId }
      : { success: false, error: 'Nao existe atualizacao anterior disponivel para rollback.' };
  } catch (e: any) {
    return { success: false, error: e.message };
  } finally {
    if (transaction) try { await discardInstallTransaction(transaction); } catch {}
    updateOperations.finish(operation);
  }
});

// ─── Game Launch ───
ipcMain.handle('get-recent-crashes', async () => {
  return collectRecentCrashLogs(5).map(file => ({
    name: file.name,
    mtime: file.mtime
  }));
});

ipcMain.handle('report-recent-crashes', async () => {
  const auth = readAuthFile();
  const config = readLauncherConfig();
  const crashes = collectRecentCrashLogs(2);
  if (crashes.length === 0) return { ok: true, sent: 0 };

  const payload = {
    discordId: auth?.discordId || null,
    username: auth?.globalName || auth?.username || null,
    clientVersion: config.gamePath ? readStamp(config.gamePath, CLIENT_VERSION_FILENAME) : null,
    launcherVersion: app.getVersion(),
    crashes: crashes.map(file => {
      const raw = fs.readFileSync(file.fullPath);
      const maxBytes = 60 * 1024;
      const content = raw.length > maxBytes
        ? Buffer.concat([raw.subarray(0, maxBytes), Buffer.from('\n...[truncado pelo launcher]')]).toString('utf8')
        : raw.toString('utf8');
      return { filename: file.name, mtime: file.mtime, content };
    })
  };

  const result = await postJsonToApi('/api/crashes/client', payload);
  return { ok: !!result?.ok || result?.status === 'ok', sent: crashes.length, response: result };
});

ipcMain.handle('launch-game', async (_event, folderPath, ticket, preparationToken) => {
  if (!folderPath) return { success: false, error: 'Caminho do jogo inválido.' };
  const gameCheck = await validateGamePath(folderPath);
  if (!gameCheck.ok) return { success: false, error: gameCheck.message || 'Somente Skyrim Steam 1.6.1170.0 é aceito.' };
  const exePath = path.join(folderPath, 'skse64_loader.exe');
  if (!fs.existsSync(exePath)) return { success: false, error: 'skse64_loader.exe não encontrado.' };

  try {
    const auth = readAuthFile();
    if (!auth || !auth.discordId) return { success: false, error: 'Autenticação expirada.' };

    const preparation = launchPreparations.consume(preparationToken, {
      gamePath: launchPathIdentity(folderPath),
      discordId: String(auth.discordId),
    });
    if (!preparation.ok) {
      return { success: false, error: `Preparação obrigatória ausente ou expirada (${preparation.reason}).` };
    }

    const session = validateSkyMpSession(ticket);
    const clientSettingsPath = path.join(folderPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt');
    let clientSettings: unknown = {};
    if (fs.existsSync(clientSettingsPath)) {
      try { clientSettings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf8')); } catch {}
    }

    const nextClientSettings = buildSkyMpClientSettings(clientSettings, {
      session,
      serverIp: SERVER_IP,
      serverPort: SERVER_PORT,
    });

    const configDir = path.dirname(clientSettingsPath);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(clientSettingsPath, JSON.stringify(nextClientSettings, null, 2));
  } catch (e) {
    console.error('Error injecting SkyMP session:', e instanceof Error ? e.message : 'unknown error');
    return { success: false, error: e instanceof Error ? e.message : 'Falha ao preparar sessão SkyMP.' };
  }

  exec('taskkill /F /T /IM SkyrimSE.exe & taskkill /F /T /IM skse64_loader.exe & taskkill /F /IM "SkyrimPlatformCEF.exe.hidden" & taskkill /F /IM "SkyrimPlatformCEF.exe"', () => {
    exec(`"${exePath}"`, { cwd: folderPath });
  });

  return { success: true };
});
