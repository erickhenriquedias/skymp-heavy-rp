#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXTRA_FILE_POLICIES,
  MODS_MANIFEST_CHANNELS,
  MODS_MANIFEST_VERSION,
  normalizeManifestPath,
  validateModsManifestContract,
} = require('../../../skymp/packages/mods-manifest-contract');
const { signUpdateManifest } = require('../../../skymp/packages/signed-update-manifest');

const EXTENSIONS = Object.freeze({
  '.esm': 'plugin', '.esp': 'plugin', '.esl': 'plugin',
  '.bsa': 'archive', '.bsl': 'archive',
  '.pex': 'script', '.psc': 'script', '.js': 'script', '.cjs': 'script', '.mjs': 'script',
  '.dll': 'binary', '.exe': 'binary',
  '.ini': 'config', '.json': 'config', '.toml': 'config',
});
const DEFAULT_IGNORED_PATHS = Object.freeze(['Data/Platform/Plugins/skymp5-client-settings.txt']);

function parseArgs(argv) {
  const args = {
    dataDir: null, out: null, pluginsTxt: null, distributionMap: null,
    onlyLoadOrder: false, channel: 'development', build: null,
    extraFilePolicy: 'reject', sequence: null, keyId: null,
    ignoredPaths: [...DEFAULT_IGNORED_PATHS],
  };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--only-load-order') { args.onlyLoadOrder = true; continue; }
    if (token === '--ignore-path') {
      if (index + 1 >= argv.length) throw new Error('Falta valor para --ignore-path.');
      args.ignoredPaths.push(argv[++index]);
      continue;
    }
    const fields = {
      '--out': 'out', '--plugins-txt': 'pluginsTxt', '--distribution-map': 'distributionMap',
      '--channel': 'channel', '--build': 'build', '--extra-file-policy': 'extraFilePolicy',
      '--sequence': 'sequence', '--key-id': 'keyId',
    };
    if (fields[token]) {
      if (index + 1 >= argv.length) throw new Error(`Falta valor para ${token}.`);
      args[fields[token]] = argv[++index];
      continue;
    }
    if (token.startsWith('--')) throw new Error(`Argumento desconhecido: ${token}.`);
    rest.push(token);
  }
  args.dataDir = rest[0] || null;
  args.sequence = Number(args.sequence);
  return args;
}

function readPluginsTxt(filePath) {
  const order = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('*')) continue;
    const name = trimmed.slice(1).trim();
    if (['.esm', '.esp', '.esl'].includes(path.extname(name).toLowerCase())) order.push(name);
  }
  return order;
}

function listFilesRecursive(dataDir) {
  const files = [];
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.toLocaleLowerCase('en-US').localeCompare(b.name.toLocaleLowerCase('en-US')));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Link simbolico recusado na Data de referencia: ${relative}`);
      if (entry.isDirectory()) { visit(absolute, relative); continue; }
      if (!entry.isFile()) continue;
      const category = EXTENSIONS[path.extname(entry.name).toLowerCase()] || 'asset';
      files.push({ absolute, relative: `Data/${relative.replace(/\\/g, '/')}`, category });
    }
  };
  visit(dataDir);
  return files;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function readDistributionMap(filePath) {
  if (!filePath) return {};
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--distribution-map precisa ser objeto path -> URL HTTPS.');
  return parsed;
}

async function generate(argv, env = process.env, now = new Date()) {
  const args = parseArgs(argv);
  if (!args.dataDir || !args.pluginsTxt || !args.build || !args.keyId || !Number.isSafeInteger(args.sequence) || args.sequence < 1) {
    throw new Error('Uso: generate-mods-manifest.js <Data> --plugins-txt plugins.txt --build ID --sequence N --key-id ID [--out mods.json] [--distribution-map map.json] [--channel development|beta|stable] [--extra-file-policy reject|warn|ignore] [--ignore-path Data/path] [--only-load-order]');
  }
  if (!MODS_MANIFEST_CHANNELS.includes(args.channel)) throw new Error(`Canal invalido: ${args.channel}.`);
  if (!EXTRA_FILE_POLICIES.includes(args.extraFilePolicy)) throw new Error(`extraFilePolicy invalida: ${args.extraFilePolicy}.`);
  if (!env.UPDATE_SIGNING_PRIVATE_KEY) throw new Error('UPDATE_SIGNING_PRIVATE_KEY ausente. O manifesto v2 nunca e publicado sem assinatura.');
  const dataDir = path.resolve(args.dataDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) throw new Error(`Pasta Data nao encontrada: ${dataDir}`);
  const pluginsPath = path.resolve(args.pluginsTxt);
  if (!fs.existsSync(pluginsPath)) throw new Error(`plugins.txt nao encontrado: ${pluginsPath}`);
  const loadOrder = readPluginsTxt(pluginsPath);
  if (loadOrder.length === 0) throw new Error('plugins.txt nao contem plugins ativos.');
  const wanted = new Set(loadOrder.map(name => name.toLocaleLowerCase('en-US')));
  const ignoredKeys = new Set();
  const ignoredPaths = args.ignoredPaths.map(ignoredPath => {
    const normalized = normalizeManifestPath(ignoredPath);
    if (!normalized || normalized !== ignoredPath) throw new Error(`Path ignorado invalido: ${ignoredPath}.`);
    const key = normalized.toLocaleLowerCase('en-US');
    if (ignoredKeys.has(key)) throw new Error(`Path ignorado duplicado: ${ignoredPath}.`);
    ignoredKeys.add(key);
    return normalized;
  });
  let candidates = listFilesRecursive(dataDir)
    .filter(file => !ignoredKeys.has(file.relative.toLocaleLowerCase('en-US')));
  if (args.onlyLoadOrder) {
    candidates = candidates.filter(file => file.category === 'plugin'
      && wanted.has(path.basename(file.relative).toLocaleLowerCase('en-US')));
  }
  const presentPlugins = new Set(candidates.filter(file => file.category === 'plugin')
    .map(file => path.basename(file.relative).toLocaleLowerCase('en-US')));
  const missing = loadOrder.filter(name => !presentPlugins.has(name.toLocaleLowerCase('en-US')));
  if (missing.length) throw new Error(`Plugins na load order que nao existem no conjunto gerado: ${missing.join(', ')}`);
  const distribution = readDistributionMap(args.distributionMap);
  const knownPaths = new Set(candidates.map(file => file.relative.toLocaleLowerCase('en-US')));
  const distributionByPath = new Map();
  for (const key of Object.keys(distribution)) {
    const normalized = key.toLocaleLowerCase('en-US');
    if (!knownPaths.has(normalized)) throw new Error(`distribution-map referencia arquivo fora do manifesto: ${key}`);
    if (distributionByPath.has(normalized)) throw new Error(`distribution-map possui colisao de path: ${key}`);
    distributionByPath.set(normalized, distribution[key]);
  }

  const files = [];
  for (const candidate of candidates) {
    const stat = fs.statSync(candidate.absolute);
    const entry = {
      path: candidate.relative,
      size: stat.size,
      sha256: await sha256File(candidate.absolute),
      required: true,
      category: candidate.category,
    };
    const mapped = distributionByPath.get(candidate.relative.toLocaleLowerCase('en-US'));
    if (mapped) entry.downloadUrl = mapped;
    files.push(entry);
  }
  const payload = {
    kind: 'parity', manifestVersion: MODS_MANIFEST_VERSION, channel: args.channel,
    build: args.build.trim(), generatedAt: now.toISOString(), extraFilePolicy: args.extraFilePolicy,
    loadOrderSource: 'plugins.txt', files, loadOrder, ignoredPaths,
  };
  const contract = validateModsManifestContract(payload);
  if (!contract.ok) throw new Error(`Contrato v2 invalido: ${contract.reason}${contract.detail ? ` (${contract.detail})` : ''}`);
  const envelope = signUpdateManifest({
    keyId: args.keyId, sequence: args.sequence, issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    payload, privateKey: env.UPDATE_SIGNING_PRIVATE_KEY,
  });
  return { args, envelope };
}

async function main() {
  const { args, envelope } = await generate(process.argv.slice(2));
  const outPath = path.resolve(args.out || path.join(__dirname, '..', 'mods.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`[manifest-v2] ${envelope.payload.files.length} arquivos, ${envelope.payload.loadOrder.length} plugins, sequence=${envelope.sequence}.`);
  console.log(`[manifest-v2] Escrito em ${outPath}`);
}

if (require.main === module) main().catch(error => { console.error(`[manifest-v2] Falhou: ${error.message}`); process.exitCode = 1; });

module.exports = { generate, listFilesRecursive, parseArgs, readPluginsTxt, sha256File };
