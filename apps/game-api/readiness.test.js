'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createReadinessProbe } = require('./readiness');

function setup({ rows = [{ ready: 1 }], manifest = { ok: true }, maintenance = false, error } = {}) {
  const calls = [];
  const probe = createReadinessProbe({
    execute: async sql => {
      calls.push(sql);
      if (error) throw error;
      return rows;
    },
    loadManifest: () => manifest,
    isMaintenance: () => maintenance
  });
  return { probe, calls };
}

describe('readiness da game-api', () => {
  test('aprova somente manifesto, MariaDB e operação normal juntos', async () => {
    const state = setup();
    assert.deepEqual(await state.probe(), {
      ready: true,
      checks: { database: 'ok', manifest: 'ok', maintenance: 'inactive' }
    });
    assert.deepEqual(state.calls, ['SELECT 1 AS ready']);
  });

  test('MariaDB indisponível reprova sem expor a exceção', async () => {
    const state = setup({ error: new Error('senha sensível') });
    const result = await state.probe();
    assert.equal(result.ready, false);
    assert.equal(result.checks.database, 'unavailable');
    assert.equal(JSON.stringify(result).includes('senha sensível'), false);
  });

  test('manifesto indisponível reprova mesmo com banco saudável', async () => {
    const result = await setup({ manifest: { ok: false, reason: 'manifest_missing' } }).probe();
    assert.equal(result.ready, false);
    assert.equal(result.checks.manifest, 'unavailable');
  });

  test('manutenção reprova readiness sem fingir falha das dependências', async () => {
    const result = await setup({ maintenance: true }).probe();
    assert.deepEqual(result, {
      ready: false,
      checks: { database: 'ok', manifest: 'ok', maintenance: 'active' }
    });
  });
});
