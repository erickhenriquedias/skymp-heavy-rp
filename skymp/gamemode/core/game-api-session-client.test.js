'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createGameApiSessionClient } = require('./game-api-session-client');

const SECRET = 's'.repeat(32);

describe('cliente interno de leases da game-api', () => {
  it('claim envia só accountId e devolve o lease opaco', async () => {
    let request;
    const client = createGameApiSessionClient({
      baseUrl: 'http://127.0.0.1:7758/', internalSecret: SECRET,
      requestImpl: async (url, options) => {
        request = { url, options };
        return { status: 200, body: { ok: true, leaseToken: 'l'.repeat(64) } };
      }
    });
    assert.equal(await client.claim(42), 'l'.repeat(64));
    assert.equal(request.url, 'http://127.0.0.1:7758/internal/session/claim');
    assert.equal(request.options.headers['X-Internal-Secret'], SECRET);
    assert.deepEqual(JSON.parse(request.options.body), { accountId: 42 });
  });

  it('release envia somente o lease, nunca accountId', async () => {
    let body;
    const client = createGameApiSessionClient({
      baseUrl: 'http://127.0.0.1:7758', internalSecret: SECRET,
      requestImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return { status: 200, body: { ok: true, released: true } };
      }
    });
    assert.deepEqual(await client.release('x'.repeat(64)), { ok: true, released: true });
    assert.deepEqual(body, { leaseToken: 'x'.repeat(64) });
  });

  it('falha fechado em HTTP recusado ou lease malformado', async () => {
    const refused = createGameApiSessionClient({
      baseUrl: 'http://127.0.0.1:7758', internalSecret: SECRET,
      requestImpl: async () => ({ status: 409, body: { ok: false } })
    });
    await assert.rejects(refused.claim(7), /HTTP 409/);

    const malformed = createGameApiSessionClient({
      baseUrl: 'http://127.0.0.1:7758', internalSecret: SECRET,
      requestImpl: async () => ({ status: 200, body: { ok: true } })
    });
    await assert.rejects(malformed.claim(7), /lease inválido/);
  });

  it('timeout aborta a autenticação pendurada', async () => {
    const client = createGameApiSessionClient({
      baseUrl: 'http://127.0.0.1:7758', internalSecret: SECRET, timeoutMs: 5,
      requestImpl: async (_url, { timeoutMs }) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('timeout da game-api')), timeoutMs);
      })
    });
    await assert.rejects(client.claim(7), /timeout/);
  });

  it('transporte http nativo funciona sem fetch global', async () => {
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        assert.equal(request.headers['x-internal-secret'], SECRET);
        assert.deepEqual(JSON.parse(raw), { accountId: 77 });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, leaseToken: 'n'.repeat(64) }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = createGameApiSessionClient({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        internalSecret: SECRET
      });
      assert.equal(await client.claim(77), 'n'.repeat(64));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
