import fs from 'node:fs';
import path from 'node:path';
import signedManifest from '../../../skymp/packages/signed-update-manifest.js';

const { enforceReleaseMonotonicity, parsePinnedPublicKeys, verifyUpdateManifest } = signedManifest;
const STATE_VERSION = 1;
const RELEASE_STATE_KEY = /^(client|mods|parity)(?::(stable|beta|development))?$/;
const UPDATE_CHANNELS = new Set(['stable', 'beta', 'development']);

export class UpdateSecurityStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateSecurityStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpdateSecurityStateError(code, message);
}

export function validateReleaseState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.keyId !== 'string' || !value.keyId
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string'
    || (value.channel !== undefined && !UPDATE_CHANNELS.has(value.channel))) {
    fail('UPDATE_SECURITY_STATE_INVALID', 'Estado local de seguranca de update esta corrompido. Reinstale o launcher; nao apague o estado para forcar downgrade.');
  }
  return { ...value };
}

export function readInstalledRelease(gamePath, filename) {
  if (!gamePath) return null;
  const filePath = path.join(gamePath, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return validateReleaseState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof UpdateSecurityStateError) throw error;
    fail('UPDATE_SECURITY_STATE_INVALID', `Estado de release instalado invalido em ${filename}.`);
  }
}

export function readRememberedReleases(statePath) {
  if (!fs.existsSync(statePath)) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    fail('UPDATE_SECURITY_STATE_INVALID', 'Historico local de releases aceitas esta corrompido.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.stateVersion !== STATE_VERSION
    || !value.releases || typeof value.releases !== 'object' || Array.isArray(value.releases)) {
    fail('UPDATE_SECURITY_STATE_INVALID', 'Historico local de releases aceitas possui formato invalido.');
  }
  const releases = {};
  for (const [kind, release] of Object.entries(value.releases)) {
    if (!RELEASE_STATE_KEY.test(kind)) fail('UPDATE_SECURITY_STATE_INVALID', 'Historico local contem canal desconhecido.');
    releases[kind] = validateReleaseState(release);
  }
  return releases;
}

export function chooseHighestRelease(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  if (first.sequence === second.sequence && first.digest !== second.digest) {
    fail('UPDATE_SECURITY_STATE_CONFLICT', 'Estados locais reutilizam a mesma sequencia com conteudo diferente.');
  }
  return first.sequence >= second.sequence ? first : second;
}

export function verifySignedUpdateEnvelope(envelope, options) {
  const publicKeys = typeof options.publicKeys === 'string'
    ? parsePinnedPublicKeys(options.publicKeys)
    : options.publicKeys;
  const verified = verifyUpdateManifest(envelope, {
    publicKeys,
    expectedKind: options.kind,
    now: options.now,
    clockSkewMs: options.clockSkewMs,
  });
  const highest = chooseHighestRelease(options.installedRelease, options.rememberedRelease);
  enforceReleaseMonotonicity(verified.release, highest);
  return verified;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function acquireStateLock(statePath) {
  const lockPath = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return { descriptor, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch {}
      if (processIsAlive(owner?.pid)) {
        fail('UPDATE_SECURITY_STATE_LOCKED', 'Outro processo do launcher esta atualizando o estado de seguranca. Tente novamente.');
      }
      try { fs.unlinkSync(lockPath); }
      catch { fail('UPDATE_SECURITY_STATE_LOCKED', 'Lock orfao do estado de seguranca nao pode ser recuperado.'); }
    }
  }
  fail('UPDATE_SECURITY_STATE_LOCKED', 'Nao foi possivel adquirir o lock do estado de seguranca.');
}

function releaseStateLock(lock) {
  try { fs.closeSync(lock.descriptor); } catch {}
  try { fs.unlinkSync(lock.lockPath); } catch {}
}

export function rememberAcceptedRelease(statePath, kind, release) {
  if (!RELEASE_STATE_KEY.test(kind)) fail('UPDATE_SECURITY_STATE_INVALID', 'Canal de release desconhecido.');
  const candidate = validateReleaseState(release);
  const lock = acquireStateLock(statePath);
  try {
    // A releitura acontece sob lock. Sem isso, dois processos poderiam ler a
    // mesma base e a gravacao mais lenta apagar o maior sequence do outro.
    const releases = readRememberedReleases(statePath);
    enforceReleaseMonotonicity(candidate, releases[kind]);
    releases[kind] = candidate;
    const state = { stateVersion: STATE_VERSION, releases };
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(tempPath, statePath);
    } finally {
      if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(tempPath); } catch {}
    }
  } finally {
    releaseStateLock(lock);
  }
  return candidate;
}

export function serializeReleaseState(release) {
  return `${JSON.stringify(validateReleaseState(release), null, 2)}\n`;
}
