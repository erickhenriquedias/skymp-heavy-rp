'use strict';

const MODS_MANIFEST_VERSION = 2;
const MODS_MANIFEST_CHANNELS = Object.freeze(['development', 'beta', 'stable']);
const EXTRA_FILE_POLICIES = Object.freeze(['reject', 'warn', 'ignore']);
const FILE_CATEGORIES = Object.freeze(['plugin', 'archive', 'script', 'binary', 'config', 'asset']);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function invalid(reason, detail) {
  return detail ? { ok: false, reason, detail } : { ok: false, reason };
}

function normalizeManifestPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || value.includes(':') || /[\u0000-\u001f]/.test(value)) return null;
  const components = value.split('/');
  if (components.length < 2) return null;
  if (components.some(component => !component || component === '.' || component === '..'
    || component.endsWith('.') || component.endsWith(' ') || RESERVED_WINDOWS_NAMES.test(component))) return null;
  if (components[0].toLocaleLowerCase('en-US') !== 'data') return null;
  return components.join('/');
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateModsManifestContract(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid('manifest_invalid_shape');
  if (data.manifestVersion !== MODS_MANIFEST_VERSION) return invalid('manifest_unsupported_version');
  if (!MODS_MANIFEST_CHANNELS.includes(data.channel)) return invalid('manifest_invalid_channel');
  if (typeof data.build !== 'string' || data.build.trim().length === 0 || data.build.length > 128) return invalid('manifest_invalid_build');
  if (!validIsoTimestamp(data.generatedAt)) return invalid('manifest_invalid_generated_at');
  if (!EXTRA_FILE_POLICIES.includes(data.extraFilePolicy)) return invalid('manifest_invalid_extra_policy');
  if (!Array.isArray(data.files) || data.files.length === 0 || data.files.length > 100_000) return invalid('manifest_invalid_files');
  if (!Array.isArray(data.loadOrder) || data.loadOrder.length === 0 || data.loadOrder.length > 4096) return invalid('manifest_invalid_load_order');
  if (data.ignoredPaths !== undefined && (!Array.isArray(data.ignoredPaths) || data.ignoredPaths.length > 256)) {
    return invalid('manifest_invalid_ignored_paths');
  }

  const paths = new Set();
  const pluginNames = new Set();
  for (const file of data.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return invalid('manifest_invalid_file');
    const normalized = normalizeManifestPath(file.path);
    if (!normalized || normalized !== file.path) return invalid('manifest_invalid_path', String(file.path ?? ''));
    const pathKey = normalized.toLocaleLowerCase('en-US');
    if (paths.has(pathKey)) return invalid('manifest_path_collision', normalized);
    paths.add(pathKey);
    if (!Number.isSafeInteger(file.size) || file.size < 0) return invalid('manifest_invalid_size', normalized);
    if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) return invalid('manifest_invalid_sha256', normalized);
    if (typeof file.required !== 'boolean') return invalid('manifest_invalid_required', normalized);
    if (!FILE_CATEGORIES.includes(file.category)) return invalid('manifest_invalid_category', normalized);
    if (file.downloadUrl !== undefined) {
      try {
        const url = new URL(file.downloadUrl);
        if (url.protocol !== 'https:' || url.username || url.password) return invalid('manifest_invalid_download_url', normalized);
      } catch { return invalid('manifest_invalid_download_url', normalized); }
    }
    if (file.category === 'plugin') pluginNames.add(normalized.split('/').at(-1).toLocaleLowerCase('en-US'));
  }

  const ignoredPaths = new Set();
  for (const ignoredPath of data.ignoredPaths || []) {
    const normalized = normalizeManifestPath(ignoredPath);
    if (!normalized || normalized !== ignoredPath) return invalid('manifest_invalid_ignored_path', String(ignoredPath ?? ''));
    const pathKey = normalized.toLocaleLowerCase('en-US');
    if (ignoredPaths.has(pathKey)) return invalid('manifest_ignored_path_collision', normalized);
    if (paths.has(pathKey)) return invalid('manifest_ignored_path_is_file', normalized);
    ignoredPaths.add(pathKey);
  }

  const ordered = new Set();
  for (const plugin of data.loadOrder) {
    if (typeof plugin !== 'string' || plugin.length < 1 || plugin.length > 255 || plugin.includes('/') || plugin.includes('\\')) {
      return invalid('manifest_invalid_load_order');
    }
    const key = plugin.toLocaleLowerCase('en-US');
    if (ordered.has(key)) return invalid('manifest_load_order_duplicate', plugin);
    if (!pluginNames.has(key)) return invalid('manifest_load_order_file_missing', plugin);
    ordered.add(key);
  }
  return { ok: true };
}

module.exports = {
  EXTRA_FILE_POLICIES,
  FILE_CATEGORIES,
  MODS_MANIFEST_CHANNELS,
  MODS_MANIFEST_VERSION,
  normalizeManifestPath,
  validateModsManifestContract,
};
