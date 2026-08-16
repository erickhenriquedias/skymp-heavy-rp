'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let resultRows = [];
let lastQuery = null;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return {
      createPool: () => ({
        execute: async (sql, params = []) => {
          lastQuery = { sql: sql.replace(/\s+/g, ' ').trim(), params };
          return [resultRows, []];
        }
      })
    };
  }
  return originalLoad.apply(this, arguments);
};

process.env.INTERNAL_API_SECRET = 'eligibility-test-secret';
const { isEligible } = require('./server');
Module._load = originalLoad;

beforeEach(() => {
  resultRows = [];
  lastQuery = null;
});

test('aprovação originada do cargo exige concessão ativa e não expirada', async () => {
  resultRows = [{ status: 'active', approved_apps: 1, approved_chars: 1 }];
  assert.deepEqual(await isEligible(7), { ok: true });
  assert.match(lastQuery.sql, /approval_source/);
  assert.match(lastQuery.sql, /FROM discord_role_access/);
  assert.match(lastQuery.sql, /dra\.eligible = 1/);
  assert.match(lastQuery.sql, /dra\.expires_at > NOW\(\)/);
});

test('sem candidatura efetivamente aprovada a fila recusa', async () => {
  resultRows = [{ status: 'active', approved_apps: 0, approved_chars: 1 }];
  assert.deepEqual(await isEligible(7), { ok: false, reason: 'not_whitelisted' });
});

test('cargo não substitui a existência de personagem aprovado', async () => {
  resultRows = [{ status: 'active', approved_apps: 1, approved_chars: 0 }];
  assert.deepEqual(await isEligible(7), { ok: false, reason: 'no_approved_character' });
});
