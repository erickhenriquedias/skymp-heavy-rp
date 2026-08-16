'use strict';

async function notifySessionConnected({
  baseUrl,
  internalSecret,
  accountId,
  sessionId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3000
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl inválida');
  if (typeof internalSecret !== 'string' || internalSecret.length === 0) throw new TypeError('internalSecret inválido');
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('accountId inválido');
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new TypeError('sessionId inválido');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch indisponível');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs inválido');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/internal/session/connected`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret
      },
      body: JSON.stringify({ accountId, sessionId }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`game-api respondeu HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.ok !== true || body.marked !== true) {
      throw new Error('game-api não confirmou a ocupação');
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { notifySessionConnected };
