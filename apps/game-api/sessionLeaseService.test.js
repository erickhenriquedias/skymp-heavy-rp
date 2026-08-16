'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSessionLeaseService } = require('./sessionLeaseService');

function setup({ admission, execute } = {}) {
  const calls = [];
  let current = admission || { accountId: 7, sessionId: 70, connected: true };
  let leaseHash = null;
  let releasedHash = null;
  const service = createSessionLeaseService({
    execute: execute || (async (sql, params) => {
      calls.push({ sql, params });
      if (/^\s*SELECT id/i.test(sql)) return [{ id: 70 }];
      return { affectedRows: 1 };
    }),
    queue: {
      getAdmission: () => current,
      confirmSessionConnected: (accountId, sessionId) => accountId === 7 && sessionId === 70,
      setConnectionLease: (_accountId, _sessionId, hash) => { leaseHash = hash; return true; },
      releaseByLeaseHash: hash => { releasedHash = hash; return true; }
    },
    hashToken: token => crypto.createHash('sha256').update(token).digest('hex'),
    makeToken: () => 'lease-token-'.padEnd(64, 'a'),
    makeSessionTicket: () => 'session'
  });
  return { service, calls, getLeaseHash: () => leaseHash, getReleasedHash: () => releasedHash };
}

describe('lease exato de sessão', () => {
  test('confirma somente a sessão ativa mais recente da conta', async () => {
    const { service } = setup();
    assert.deepEqual(await service.confirmConnected(7, 70), { ok: true });
    assert.deepEqual(await service.confirmConnected(7, 71), { ok: false, reason: 'stale_session' });
  });

  test('claim persiste somente hash e devolve token opaco', async () => {
    const state = setup();
    const result = await state.service.claim(7);
    assert.equal(result.ok, true);
    assert.equal(result.leaseToken.length, 64);
    assert.notEqual(state.getLeaseHash(), result.leaseToken);
    const update = state.calls.find(call => /SET connection_lease_hash/.test(call.sql));
    assert.equal(update.params[0], state.getLeaseHash());
    assert.equal(update.params.includes(result.leaseToken), false);
  });

  test('disconnect antigo é idempotente e não libera a admissão atual', async () => {
    const state = setup({ execute: async () => ({ affectedRows: 0 }) });
    assert.deepEqual(
      await state.service.release('old-lease'.padEnd(64, 'x')),
      { ok: true, released: false, stale: true }
    );
    assert.equal(state.getReleasedHash(), null);
  });

  test('release válido revoga pelo hash exato e libera a fila correspondente', async () => {
    const state = setup();
    const token = 'current-lease'.padEnd(64, 'x');
    const result = await state.service.release(token);
    assert.deepEqual(result, { ok: true, released: true });
    assert.equal(
      state.getReleasedHash(),
      crypto.createHash('sha256').update(token).digest('hex')
    );
  });

  test('claim sem admissão conectada falha sem SQL', async () => {
    let executions = 0;
    const state = setup({
      admission: { accountId: 7, sessionId: 70, connected: false },
      execute: async () => { executions += 1; }
    });
    assert.deepEqual(
      await state.service.claim(7),
      { ok: false, reason: 'connected_admission_not_found' }
    );
    assert.equal(executions, 0);
  });
});
