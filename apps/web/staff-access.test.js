'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { permissionsForRole, createStaffGuard } = require('./staff-access');

function responseDouble() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function runGuard({ role, permission = null, authenticated = true, dbError = null }) {
  const db = async () => {
    if (dbError) throw dbError;
    return role === null ? [] : [{ role }];
  };
  const guard = createStaffGuard(db, permission);
  const req = {
    isAuthenticated: () => authenticated,
    user: { accountId: 7 }
  };
  const res = responseDouble();
  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

describe('catálogo de staff do painel', () => {
  test('espelha permissões críticas do gamemode', () => {
    assert.equal(permissionsForRole('moderator').has('manage_whitelist'), true);
    assert.equal(permissionsForRole('moderator').has('view_audit'), true);
    assert.equal(permissionsForRole('moderator').has('retire_character'), false);
    assert.equal(permissionsForRole('owner').has('manage_staff'), true);
  });

  test('cargo desconhecido não vira staff com acesso total', async () => {
    const result = await runGuard({ role: 'developer' });
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 403);
    assert.match(result.res.body.error, /inválido/);
  });

  test('nome herdado do protótipo também é tratado como cargo desconhecido', async () => {
    const result = await runGuard({ role: 'constructor' });
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 403);
  });

  test('linha ausente continua sendo acesso negado', async () => {
    const result = await runGuard({ role: null });
    assert.equal(result.res.statusCode, 403);
  });
});

describe('guard por permissão', () => {
  test('autoriza somente quando o cargo possui a permissão exigida', async () => {
    const allowed = await runGuard({ role: 'moderator', permission: 'manage_whitelist' });
    const denied = await runGuard({ role: 'moderator', permission: 'retire_character' });
    assert.equal(allowed.nextCalled, true);
    assert.equal(allowed.req.staff.role, 'moderator');
    assert.equal(denied.nextCalled, false);
    assert.equal(denied.res.statusCode, 403);
  });

  test('nega antes do banco quando a sessão não está autenticada', async () => {
    const result = await runGuard({ role: 'owner', authenticated: false });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalled, false);
  });

  test('falha de banco não vira acesso negado silencioso nem libera', async () => {
    const result = await runGuard({ role: 'owner', dbError: new Error('db down') });
    assert.equal(result.res.statusCode, 500);
    assert.equal(result.nextCalled, false);
  });
});
