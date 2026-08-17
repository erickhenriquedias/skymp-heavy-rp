import crypto from 'node:crypto';

export const PREPARATION_TTL_MS = 4 * 60 * 60_000;

export function classifyUpdateReadiness(client, mods) {
  if (!client || client.error) {
    return { status: 'blocked', code: 'CLIENT_UPDATE_CHECK_FAILED', action: 'retry', message: client?.error || 'Falha ao consultar atualização do cliente.' };
  }
  if (client.updateAvailable) {
    return {
      status: 'blocked', code: 'CLIENT_UPDATE_REQUIRED', action: 'update-client',
      message: `Atualização obrigatória do cliente: ${client.installedVersion || 'não instalado'} → ${client.version}.`,
    };
  }
  if (!mods || mods.error) {
    return { status: 'blocked', code: 'MODS_UPDATE_CHECK_FAILED', action: 'retry', message: mods?.error || 'Falha ao consultar atualização do modpack.' };
  }
  if (mods.updateAvailable) {
    return {
      status: 'blocked', code: 'MODS_UPDATE_REQUIRED', action: 'update-mods',
      message: `Atualização obrigatória do modpack: ${mods.installedVersion || 'não instalado'} → ${mods.version}.`,
    };
  }
  return { status: 'continue' };
}

export function classifyParityReadiness(verification, analysis) {
  if (!verification?.success) {
    const problems = Array.isArray(verification?.problems) ? verification.problems : [];
    return {
      status: 'blocked', code: 'MODPACK_INVALID', action: 'repair-mods',
      message: verification?.error || 'O modpack instalado não corresponde ao servidor.', problems,
    };
  }
  if (!analysis?.ok) {
    const problems = Array.isArray(analysis?.problems) ? analysis.problems : [];
    return {
      status: 'blocked', code: 'LOAD_ORDER_INVALID', action: 'settings',
      message: problems[0] || 'A load order não pôde ser corrigida.', problems,
    };
  }
  return { status: 'ready' };
}

export class LaunchPreparationStore {
  constructor({ ttlMs = PREPARATION_TTL_MS, randomToken = () => crypto.randomBytes(32).toString('base64url') } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs inválido.');
    this.ttlMs = ttlMs;
    this.randomToken = randomToken;
    this.current = null;
  }

  issue({ gamePath, discordId, now = Date.now() }) {
    if (typeof gamePath !== 'string' || !gamePath || typeof discordId !== 'string' || !discordId) {
      throw new Error('Contexto de preparação inválido.');
    }
    const token = this.randomToken();
    if (typeof token !== 'string' || token.length < 32) throw new Error('Token de preparação inseguro.');
    this.current = { token, gamePath, discordId, expiresAt: now + this.ttlMs };
    return { token, expiresAt: this.current.expiresAt };
  }

  consume(token, { gamePath, discordId, now = Date.now() }) {
    const result = this.validate(token, { gamePath, discordId, now });
    const current = this.current;
    if (current && token === current.token) this.current = null;
    return result;
  }

  validate(token, { gamePath, discordId, now = Date.now() }) {
    const current = this.current;
    if (!current || typeof token !== 'string' || token !== current.token) return { ok: false, reason: 'preparation_missing' };
    if (now > current.expiresAt) return { ok: false, reason: 'preparation_expired' };
    if (gamePath !== current.gamePath || discordId !== current.discordId) return { ok: false, reason: 'preparation_context_changed' };
    return { ok: true };
  }

  clear() {
    this.current = null;
  }
}
