import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  LaunchPreparationStore,
  classifyParityReadiness,
  classifyUpdateReadiness,
} from './launch-readiness.mjs';

describe('gate obrigatório antes de jogar', () => {
  test('erro de feed falha fechado e atualização do cliente tem prioridade', () => {
    assert.equal(classifyUpdateReadiness({ error: 'feed offline' }, {}).code, 'CLIENT_UPDATE_CHECK_FAILED');
    const result = classifyUpdateReadiness(
      { updateAvailable: true, installedVersion: '1', version: '2' },
      { updateAvailable: true, installedVersion: '3', version: '4' },
    );
    assert.equal(result.action, 'update-client');
  });

  test('modpack desatualizado oferece update e paridade divergente oferece repair incremental', () => {
    assert.equal(classifyUpdateReadiness(
      { updateAvailable: false }, { updateAvailable: true, installedVersion: '1', version: '2' },
    ).action, 'update-mods');
    const parity = classifyParityReadiness({ success: false, problems: ['A', 'B'] }, null);
    assert.equal(parity.action, 'repair-mods');
    assert.deepEqual(parity.problems, ['A', 'B']);
  });

  test('somente update atual, paridade e load order válidos chegam a ready', () => {
    assert.equal(classifyUpdateReadiness({ updateAvailable: false }, { updateAvailable: false }).status, 'continue');
    assert.deepEqual(classifyParityReadiness({ success: true }, { ok: true }), { status: 'ready' });
    const loadOrder = classifyParityReadiness({ success: true }, { ok: false, problems: ['master ausente'] });
    assert.equal(loadOrder.code, 'LOAD_ORDER_INVALID');
    assert.equal(loadOrder.action, 'settings');
  });

  test('recibo é opaco, vinculado ao path/Discord, expira e só pode ser consumido uma vez', () => {
    const store = new LaunchPreparationStore({ ttlMs: 100, randomToken: () => 'x'.repeat(43) });
    const receipt = store.issue({ gamePath: 'c:/game', discordId: '123', now: 1000 });
    assert.equal(store.consume(receipt.token, { gamePath: 'c:/other', discordId: '123', now: 1001 }).reason, 'preparation_context_changed');
    assert.equal(store.consume(receipt.token, { gamePath: 'c:/game', discordId: '123', now: 1001 }).reason, 'preparation_missing');

    const expired = store.issue({ gamePath: 'c:/game', discordId: '123', now: 2000 });
    assert.equal(store.consume(expired.token, { gamePath: 'c:/game', discordId: '123', now: 2101 }).reason, 'preparation_expired');

    const valid = store.issue({ gamePath: 'c:/game', discordId: '123', now: 3000 });
    assert.deepEqual(store.validate(valid.token, { gamePath: 'c:/game', discordId: '123', now: 3001 }), { ok: true });
    assert.deepEqual(store.validate(valid.token, { gamePath: 'c:/game', discordId: '123', now: 3001 }), { ok: true });
    assert.deepEqual(store.consume(valid.token, { gamePath: 'c:/game', discordId: '123', now: 3001 }), { ok: true });
    assert.equal(store.consume(valid.token, { gamePath: 'c:/game', discordId: '123', now: 3002 }).reason, 'preparation_missing');
  });
});
