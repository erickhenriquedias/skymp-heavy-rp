'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const {
  verifiedSteamConnection,
  persistObservedSteamIdentity,
  fetchDiscordConnections
} = require('./steam-identity');

function fakePool(rows = []) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    execute: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [/^SELECT/.test(sql.trim()) ? rows : { affectedRows: 1 }, []];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
  return { pool: { getConnection: async () => connection }, calls };
}

const steamConnection = (id = '76561198000000001') => ({
  type: 'steam', id, name: 'Dragonborn', verified: true
});

describe('Steam ID secundário obtido pelo Discord', () => {
  test('aceita somente conexão Steam verificada com SteamID64 válido', () => {
    assert.equal(verifiedSteamConnection(null), null);
    assert.equal(verifiedSteamConnection([{ ...steamConnection(), verified: false }]), null);
    assert.equal(verifiedSteamConnection([{ ...steamConnection(), id: '123' }]), null);
    assert.deepEqual(verifiedSteamConnection([steamConnection()]), {
      steamId: '76561198000000001', displayName: 'Dragonborn'
    });
  });

  test('insere vínculo novo sem usar Steam para autenticação', async () => {
    const { pool, calls } = fakePool();
    const result = await persistObservedSteamIdentity({ pool, accountId: 42, connections: [steamConnection()] });
    assert.deepEqual(result, {
      linked: true, reason: 'verified_discord_connection', steamId: '76561198000000001'
    });
    assert.ok(calls.some(call => call.sql?.startsWith('INSERT INTO steam_identities')));
    assert.ok(calls.includes('commit'));
  });

  test('atualiza o identificador da mesma conta sob lock', async () => {
    const { pool, calls } = fakePool([{ steam_id: '76561198000000000', account_id: 42 }]);
    await persistObservedSteamIdentity({ pool, accountId: 42, connections: [steamConnection()] });
    assert.ok(calls.some(call => call.sql?.startsWith('UPDATE steam_identities')));
    assert.ok(calls.includes('commit'));
  });

  test('não toma Steam ID já vinculado a outra conta', async () => {
    const { pool, calls } = fakePool([{ steam_id: '76561198000000001', account_id: 99 }]);
    const result = await persistObservedSteamIdentity({ pool, accountId: 42, connections: [steamConnection()] });
    assert.deepEqual(result, { linked: false, reason: 'already_linked', steamId: null });
    assert.ok(calls.includes('rollback'));
    assert.ok(!calls.includes('commit'));
  });

  test('os dois logins continuam Discord e pedem apenas o metadado connections', () => {
    const panel = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const identity = fs.readFileSync(path.join(__dirname, 'steam-identity.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(__dirname, '..', 'launcher', 'electron', 'main.ts'), 'utf8');
    assert.match(panel, /passport\.authenticate\('discord', \{\s*scope:\s*\['identify', 'connections'\]/);
    assert.match(panel, /scope:\s*\['identify'\]/);
    assert.match(identity, /discord\.com\/api\/users\/@me\/connections/);
    assert.match(launcher, /scope=identify%20connections/);
    assert.doesNotMatch(`${panel}\n${identity}\n${launcher}`, /auth\/steam|passport-steam/i);
  });

  test('falha da API de conexões não bloqueia o login Discord', async () => {
    const errors = [];
    const logger = { error: message => errors.push(message) };
    const unavailable = await fetchDiscordConnections('token', async () => ({ ok: false }), logger);
    const networkFailure = await fetchDiscordConnections('token', async () => { throw new Error('offline'); }, logger);
    assert.deepEqual(unavailable, []);
    assert.deepEqual(networkFailure, []);
    assert.equal(errors.length, 2);
  });
});
