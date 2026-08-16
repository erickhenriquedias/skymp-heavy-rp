'use strict';

const http = require('node:http');
const https = require('node:https');

function requestJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('protocolo interno inválido'));
      return;
    }
    const request = transport.request(parsed, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 64 * 1024) request.destroy(new Error('resposta da game-api muito grande'));
      });
      response.on('end', () => {
        let parsedBody = null;
        try { parsedBody = JSON.parse(raw); } catch (_) { /* resposta inválida falha abaixo */ }
        resolve({ status: Number(response.statusCode || 0), body: parsedBody });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout da game-api')));
    request.once('error', reject);
    request.end(body);
  });
}

function createGameApiSessionClient({
  baseUrl,
  internalSecret,
  requestImpl = requestJson,
  timeoutMs = 3000
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl inválida');
  if (typeof internalSecret !== 'string' || internalSecret.length < 32) {
    throw new TypeError('INTERNAL_API_SECRET deve ter pelo menos 32 caracteres');
  }
  if (typeof requestImpl !== 'function') throw new TypeError('requestImpl inválido');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs inválido');

  async function post(path, body) {
    const payload = JSON.stringify(body);
    const response = await requestImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret
      },
      body: payload,
      timeoutMs
    });
    const result = response?.body;
    if (response?.status < 200 || response?.status >= 300 || !result || result.ok !== true) {
      throw new Error(`game-api recusou ${path} (HTTP ${response?.status || 0})`);
    }
    return result;
  }

  async function claim(accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('accountId inválido');
    const result = await post('/internal/session/claim', { accountId });
    if (typeof result.leaseToken !== 'string' || result.leaseToken.length < 32) {
      throw new Error('game-api devolveu lease inválido');
    }
    return result.leaseToken;
  }

  async function release(leaseToken) {
    if (typeof leaseToken !== 'string' || leaseToken.length < 32) {
      throw new TypeError('leaseToken inválido');
    }
    return post('/internal/session/release', { leaseToken });
  }

  return { claim, release };
}

module.exports = { createGameApiSessionClient, requestJson };
