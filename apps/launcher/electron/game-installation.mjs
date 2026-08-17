import fs from 'node:fs/promises';
import path from 'node:path';

export const REQUIRED_SKYRIM_VERSION = '1.6.1170.0';

export function normalizeSkyrimVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/(?:^|\D)(\d+\.\d+\.\d+(?:\.\d+)?)(?:\D|$)/);
  if (!match) return null;
  return match[1].split('.').length === 3 ? `${match[1]}.0` : match[1];
}

async function safeEntry(root, actualName, expectedType) {
  try {
    const stat = await fs.lstat(path.join(root, actualName));
    if (stat.isSymbolicLink()) return false;
    return expectedType === 'directory' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

export async function inspectSteamSkyrimInstallation(folderPath, options = {}) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    return { ok: false, reason: 'empty', message: 'Selecione a pasta do Skyrim.' };
  }
  const root = path.resolve(folderPath);
  let names;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe root');
    names = await fs.readdir(root);
  } catch {
    return { ok: false, reason: 'not-directory', message: 'A pasta selecionada não existe ou é insegura.' };
  }
  const byLower = new Map(names.map(name => [name.toLocaleLowerCase('en-US'), name]));
  const find = name => byLower.get(name.toLocaleLowerCase('en-US'));
  const skyrimExe = find('SkyrimSE.exe');
  if (!skyrimExe || !await safeEntry(root, skyrimExe, 'file')) {
    return { ok: false, reason: 'no-skyrim', message: 'SkyrimSE.exe não foi encontrado.' };
  }
  const hasGogMarker = find('Galaxy64.dll') || find('Galaxy.dll') || names.some(name => /^goggame-.*\.info$/i.test(name));
  if (hasGogMarker) {
    return { ok: false, reason: 'gog', message: 'A edição GOG não é aceita. Use o Skyrim Special Edition da Steam.' };
  }
  const steamApi = find('steam_api64.dll');
  if (!steamApi || !await safeEntry(root, steamApi, 'file')) {
    return { ok: false, reason: 'not-steam', message: 'Instalação Steam não reconhecida: steam_api64.dll ausente.' };
  }
  const dataDir = find('Data');
  if (!dataDir || !await safeEntry(root, dataDir, 'directory')) {
    return { ok: false, reason: 'no-data', message: 'A pasta Data do Skyrim não foi encontrada.' };
  }
  const readExecutableVersion = options.readExecutableVersion;
  if (typeof readExecutableVersion !== 'function') {
    return { ok: false, reason: 'version-unreadable', message: 'Não foi possível verificar a versão do Skyrim.' };
  }
  let rawVersion;
  try {
    rawVersion = await readExecutableVersion(path.join(root, skyrimExe));
  } catch {
    return { ok: false, reason: 'version-unreadable', message: 'Não foi possível ler a versão do SkyrimSE.exe.' };
  }
  const version = normalizeSkyrimVersion(rawVersion);
  if (!version) {
    return { ok: false, reason: 'version-unreadable', message: 'A versão do SkyrimSE.exe é inválida ou desconhecida.' };
  }
  if (version !== REQUIRED_SKYRIM_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      version,
      requiredVersion: REQUIRED_SKYRIM_VERSION,
      message: `Versão ${version} não aceita. Instale a versão Steam ${REQUIRED_SKYRIM_VERSION}.`,
    };
  }
  return { ok: true, reason: 'ok', platform: 'steam', version };
}
