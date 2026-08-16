const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const Module = require('node:module');

const queries = [];
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === './database') {
    return {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/FROM accounts a\s+WHERE a\.id = \?/i.test(sql)) {
          return [{ id: 42, status: 'active', vip_level: 0 }];
        }
        if (/FROM whitelist_applications/i.test(sql)) return [{ status: 'approved' }];
        if (/FROM characters/i.test(sql)) {
          return [{ id: 7, first_name: 'Alvara', last_name: 'Dawnmere', pos_x: 0, pos_y: 0, pos_z: 0, angle_z: 0, cell_id: '0x3c' }];
        }
        return [];
      }
    };
  }
  if (request === './commands') return { registerActiveCharacter: () => {} };
  if (request === './inventory-service') return { syncInventoryToClient: async () => {} };
  if (request === './admin-service') return { registerStaffRole: async () => {} };
  if (request === './core/character-state') return { initialize: async () => {} };
  if (request === './core/server-options') return { get: () => 0 };
  if (request === './core/transaction-service') return { addGold: async () => {} };
  if (request === './core/module-registry') return { isEnabled: () => false };
  return originalLoad.apply(this, arguments);
};

const whitelist = require('./whitelist');
Module._load = originalLoad;

beforeEach(() => {
  queries.length = 0;
});

after(() => {
  delete global.mp;
});

test('whitelist resolves online profileId directly as accounts.id', async () => {
  const allowed = await whitelist.checkWhitelist(1, 42, 0xff000001);

  assert.equal(allowed, true);
  const accountLookup = queries.find(({ sql }) => /FROM accounts a\s+WHERE a\.id = \?/i.test(sql));
  assert.deepEqual(accountLookup.params, [42]);
  assert.equal(
    queries.some(({ sql }) => /discord_identities|d\.discord_id/i.test(sql)),
    false,
    'the gamemode must not interpret profileId as a Discord ID'
  );
});

test('profile contract accepts only a positive safe integer', () => {
  assert.equal(whitelist.accountIdFromProfileId(42), 42);
  assert.equal(whitelist.accountIdFromProfileId('42'), 42);
  assert.equal(whitelist.accountIdFromProfileId(0), null);
  assert.equal(whitelist.accountIdFromProfileId('discord-id'), null);
});

test('aprovação via Discord exige concessão de cargo ativa e não expirada', async () => {
  await whitelist.checkWhitelist(1, 42, 0xff000001);
  const query = queries.find(({ sql }) => /FROM whitelist_applications w/i.test(sql));
  assert.ok(query, 'consulta efetiva de whitelist não foi executada');
  assert.match(query.sql, /approval_source/);
  assert.match(query.sql, /FROM discord_role_access/);
  assert.match(query.sql, /eligible = 1/);
  assert.match(query.sql, /expires_at > NOW\(\)/);
});
