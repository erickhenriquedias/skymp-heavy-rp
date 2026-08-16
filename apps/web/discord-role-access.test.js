'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyDiscordRoleAccess, persistDiscordRoleAccess } = require('./discord-role-access');

function fakePool(handler) {
  const log = [];
  const connection = {
    beginTransaction: async () => log.push('begin'),
    execute: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      log.push({ sql: normalized, params });
      return [await handler(normalized, params), []];
    },
    commit: async () => log.push('commit'),
    rollback: async () => log.push('rollback'),
    release: () => log.push('release')
  };
  return { pool: { getConnection: async () => connection }, log };
}

describe('verificação server-side do cargo Discord', () => {
  test('envia apenas o discord_id ao bot interno e normaliza a resposta', async () => {
    let request;
    const result = await verifyDiscordRoleAccess({
      botInternalUrl: 'http://bot',
      internalSecret: 'secret',
      discordId: '123456789',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ eligible: true, matched_role_id: 'role-1' }) };
      }
    });
    assert.deepEqual(result, { eligible: true, matchedRoleId: 'role-1' });
    assert.equal(request.url, 'http://bot/api/check-game-access');
    assert.equal(request.options.headers['X-Internal-Secret'], 'secret');
  });

  test('falha fechado quando o bot não confirma', async () => {
    await assert.rejects(verifyDiscordRoleAccess({
      botInternalUrl: 'http://bot',
      internalSecret: 'secret',
      discordId: '123456789',
      fetchImpl: async () => ({ ok: false, status: 503 })
    }), /503/);
  });
});

describe('persistência do acesso por cargo', () => {
  test('cargo promove somente a candidatura e personagem vinculados', async () => {
    const { pool, log } = fakePool((sql) => {
      if (/SELECT id FROM accounts/.test(sql)) return [{ id: 7 }];
      if (/FROM discord_identities/.test(sql)) return [{ discord_id: '123456789' }];
      if (/INSERT INTO discord_role_access/.test(sql)) return { affectedRows: 1 };
      if (/SELECT wa.id/.test(sql)) return [{ id: 41, character_id: 31, status: 'pending', character_status: 'pending' }];
      if (/UPDATE whitelist_applications/.test(sql)) return { affectedRows: 1 };
      if (/UPDATE characters/.test(sql)) return { affectedRows: 1 };
      if (/INSERT INTO audit_logs/.test(sql)) return { affectedRows: 1 };
      throw new Error(`SQL inesperado: ${sql}`);
    });
    const result = await persistDiscordRoleAccess(pool, {
      accountId: 7,
      discordId: '123456789',
      eligible: true,
      matchedRoleId: 'role-1',
      ttlSeconds: 3600
    });
    assert.deepEqual(result, { eligible: true, promoted: true, revoked: false });
    const charUpdate = log.find((entry) => entry.sql?.startsWith('UPDATE characters'));
    assert.deepEqual(charUpdate.params, [31, 7]);
    assert.deepEqual(log.filter((entry) => typeof entry === 'string'), ['begin', 'commit', 'release']);
  });

  test('remoção do cargo não altera aprovação manual', async () => {
    const { pool, log } = fakePool((sql) => {
      if (/SELECT id FROM accounts/.test(sql)) return [{ id: 7 }];
      if (/FROM discord_identities/.test(sql)) return [{ discord_id: '123456789' }];
      if (/INSERT INTO discord_role_access/.test(sql)) return { affectedRows: 2 };
      if (/approval_source = 'discord_role'/.test(sql)) return [];
      throw new Error(`SQL inesperado: ${sql}`);
    });
    const result = await persistDiscordRoleAccess(pool, {
      accountId: 7,
      discordId: '123456789',
      eligible: false,
      matchedRoleId: null
    });
    assert.deepEqual(result, { eligible: false, promoted: false, revoked: false });
    assert.equal(log.some((entry) => /UPDATE whitelist_applications/.test(entry.sql || '')), false);
  });

  test('remoção revoga somente aprovação originada do cargo', async () => {
    const { pool, log } = fakePool((sql) => {
      if (/SELECT id FROM accounts/.test(sql)) return [{ id: 7 }];
      if (/FROM discord_identities/.test(sql)) return [{ discord_id: '123456789' }];
      if (/INSERT INTO discord_role_access/.test(sql)) return { affectedRows: 2 };
      if (/approval_source = 'discord_role'/.test(sql) && /^SELECT/.test(sql)) {
        return [{ id: 41, character_id: 31, character_status: 'approved' }];
      }
      if (/UPDATE whitelist_applications/.test(sql)) return { affectedRows: 1 };
      if (/UPDATE characters/.test(sql)) return { affectedRows: 1 };
      if (/INSERT INTO audit_logs/.test(sql)) return { affectedRows: 1 };
      throw new Error(`SQL inesperado: ${sql}`);
    });
    const result = await persistDiscordRoleAccess(pool, {
      accountId: 7,
      discordId: '123456789',
      eligible: false,
      matchedRoleId: null
    });
    assert.deepEqual(result, { eligible: false, promoted: false, revoked: true });
    assert.ok(log.some((entry) => /SET status = 'pending'/.test(entry.sql || '')));
    assert.ok(log.some((entry) => /whitelist:discord_role_revoke/.test(entry.sql || '')));
  });
});
