'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { notifySessionConnected } = require('./session-occupancy-notifier');

describe('sincronização master → ocupação da fila', () => {
  test('envia a conta e a sessão exata pelo endpoint interno autenticado', async () => {
    let request;
    const result = await notifySessionConnected({
      baseUrl: 'http://127.0.0.1:7758/',
      internalSecret: 'segredo',
      accountId: 42,
      sessionId: 70,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ ok: true, marked: true }) };
      }
    });
    assert.equal(request.url, 'http://127.0.0.1:7758/internal/session/connected');
    assert.equal(request.options.headers['X-Internal-Secret'], 'segredo');
    assert.deepEqual(JSON.parse(request.options.body), { accountId: 42, sessionId: 70 });
    assert.deepEqual(result, { ok: true, marked: true });
  });

  test('resposta sem confirmação falha fechado', async () => {
    await assert.rejects(
      notifySessionConnected({
        baseUrl: 'http://127.0.0.1:7758', internalSecret: 'segredo', accountId: 42, sessionId: 70,
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, marked: false }) })
      }),
      /não confirmou/
    );
  });

  test('erro HTTP é propagado sem aceitar a sessão', async () => {
    await assert.rejects(
      notifySessionConnected({
        baseUrl: 'http://127.0.0.1:7758', internalSecret: 'segredo', accountId: 42, sessionId: 70,
        fetchImpl: async () => ({ ok: false, status: 409 })
      }),
      /HTTP 409/
    );
  });

  test('timeout interrompe a chamada em vez de pendurar o login', async () => {
    await assert.rejects(
      notifySessionConnected({
        baseUrl: 'http://127.0.0.1:7758',
        internalSecret: 'segredo',
        accountId: 42,
        sessionId: 70,
        timeoutMs: 5,
        fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
      }),
      /aborted/
    );
  });

  test('recusa sessionId ausente antes de chamar a rede', async () => {
    let called = false;
    await assert.rejects(
      notifySessionConnected({
        baseUrl: 'http://127.0.0.1:7758', internalSecret: 'segredo', accountId: 42,
        fetchImpl: async () => { called = true; }
      }),
      /sessionId inválido/
    );
    assert.equal(called, false);
  });
});
