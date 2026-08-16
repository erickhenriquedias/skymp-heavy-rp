const PUBLIC_STATES = new Set(['online', 'full', 'starting', 'maintenance']);
const DEFAULT_MESSAGES = Object.freeze({
  offline: 'Não foi possível consultar o servidor.',
  starting: 'Servidor inicializando ou temporariamente indisponível.',
  maintenance: 'Servidor em manutenção. Tente novamente em breve.',
});

function publicCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function publicMessage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (!normalized) return fallback;
  return normalized.slice(0, 160);
}

export function offlineServerStatus() {
  return {
    state: 'offline',
    players: 0,
    capacity: 0,
    queue: 0,
    message: DEFAULT_MESSAGES.offline,
  };
}

export function normalizeServerStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return offlineServerStatus();
  }

  const state = PUBLIC_STATES.has(payload.state) ? payload.state : 'offline';
  if (state === 'offline') return offlineServerStatus();

  const fallback = state === 'maintenance'
    ? DEFAULT_MESSAGES.maintenance
    : state === 'starting'
      ? DEFAULT_MESSAGES.starting
      : null;

  return {
    state,
    players: publicCount(payload.players),
    capacity: publicCount(payload.capacity),
    queue: publicCount(payload.queue),
    message: publicMessage(payload.message, fallback),
  };
}
