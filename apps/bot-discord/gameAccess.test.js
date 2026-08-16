'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGameAccessRoleIds, getMemberGameAccess } = require('./gameAccess');

describe('cargos que concedem acesso ao jogo', () => {
  test('usa WHITELIST_ROLE_ID e cargos adicionais sem duplicar', () => {
    assert.deepEqual(
      parseGameAccessRoleIds('wl', 'vip, tester,wl'),
      ['wl', 'vip', 'tester']
    );
  });

  test('aceita qualquer cargo configurado e informa qual correspondeu', () => {
    const member = { roles: { cache: new Map([['tester', {}]]) } };
    assert.deepEqual(getMemberGameAccess(member, ['wl', 'tester']), {
      eligible: true,
      matchedRoleId: 'tester'
    });
  });

  test('falha fechado quando o membro não possui cargo elegível', () => {
    const member = { roles: { cache: new Map([['visitante', {}]]) } };
    assert.deepEqual(getMemberGameAccess(member, ['wl']), {
      eligible: false,
      matchedRoleId: null
    });
  });
});
