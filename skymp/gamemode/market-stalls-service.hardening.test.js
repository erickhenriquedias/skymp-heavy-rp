/**
 * market-stalls-service.hardening.test.js
 *
 * Regressão para o fix de duplicação de item: removeItem/packStall agora
 * travam a linha (FOR UPDATE) dentro de uma transação real antes de marcar
 * o item como removido — antes, um SELECT solto sem transação permitia que
 * duas chamadas concorrentes (ex: /stallremove + /stallpack) lessem o mesmo
 * status='listed' e ambas devolvessem o item, duplicando-o.
 *
 * Também trava a fronteira de atomicidade com o inventário: mudança da pilha,
 * ledger e anúncio precisam usar a MESMA conexão antes do commit. Um erro no
 * anúncio deve pedir rollback, sem projetar o item no cliente.
 *
 * Executa com: node --test market-stalls-service.hardening.test.js
 */

const assert = require('assert');
const { describe, it, before, after } = require('node:test');

const OWNER_CHARACTER_ID = 7001;
const OWNER_ACTOR_ID = 0xff007001;
const STALL_ID = 55;
const ITEM_ID = 123;

const connEvents = []; // { op: 'begin'|'commit'|'rollback', queries: [...] }
let currentConnQueries = null;
let failQueryPattern = null;

function makeConn() {
  currentConnQueries = [];
  const queries = currentConnQueries;
  return {
    beginTransaction: async () => { connEvents.push({ op: 'begin' }); },
    commit: async () => { connEvents.push({ op: 'commit', queries: [...queries] }); },
    rollback: async () => { connEvents.push({ op: 'rollback', queries: [...queries] }); },
    release: () => {},
    query: async (sql, params = []) => {
      queries.push(sql);
      if (failQueryPattern?.test(sql)) throw new Error('falha SQL forçada');

      if (/FROM market_stall_items msi[\s\S]*INNER JOIN market_stalls/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        return [[{
          id: ITEM_ID, base_id: 0x1234, count: 3, status: 'listed',
          owner_character_id: OWNER_CHARACTER_ID, stall_id: STALL_ID
        }]];
      }
      if (/UPDATE market_stall_items SET status/i.test(sql)) return [[{}]];
      if (/FROM market_stalls WHERE id = \? AND status = \?[\s\S]*FOR UPDATE/i.test(sql)) {
        return [[{ id: STALL_ID, owner_character_id: OWNER_CHARACTER_ID, status: 'active', visual_ref_id: null }]];
      }
      if (/FROM market_stall_items[\s\S]*WHERE stall_id = \? AND status = 'listed' AND count > 0[\s\S]*FOR UPDATE/i.test(sql)) {
        return [[{ id: ITEM_ID, base_id: 0x1234, count: 3 }]];
      }
      if (/UPDATE market_stalls SET status/i.test(sql)) return [[{}]];
      // Caminho generico usado pelo inventory-service/transaction-service (giveItem)
      if (/SELECT count FROM character_inventory/i.test(sql)) return [[{ count: 10 }]];
      return [[]];
    }
  };
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database' || request === '../database') {
    return {
      query: async () => [],
      getConnection: async () => makeConn(),
      init: () => {}
    };
  }
  return originalLoad.apply(this, arguments);
};

const commands = require('./commands');
const marketStalls = require('./market-stalls-service');

Module._load = originalLoad;

describe('market-stalls-service — hardening (lock antes de remover/recolher)', () => {
  before(async () => {
    await marketStalls.initMarketStallsService();
    commands.registerActiveCharacter(OWNER_ACTOR_ID, { id: OWNER_CHARACTER_ID, first_name: 'Dono', last_name: 'Barraca' }, 1, 1);
  });

  after(() => {
    marketStalls.shutdownMarketStallsService();
    commands.removeActiveCharacter(OWNER_ACTOR_ID);
  });

  it('removeItem abre transação e trava a linha do item com FOR UPDATE', async () => {
    connEvents.length = 0;
    await marketStalls.removeItem(OWNER_ACTOR_ID, ITEM_ID);

    const commitEvent = connEvents.find(e => e.op === 'commit');
    assert.ok(commitEvent, 'removeItem deveria ter commitado uma transação');
    assert.ok(
      commitEvent.queries.some(q => /FOR UPDATE/i.test(q)),
      'a query que lê o item deveria usar FOR UPDATE'
    );
    assert.ok(
      commitEvent.queries.some(q => /UPDATE market_stall_items SET status/i.test(q)),
      'removeItem deveria marcar o item como removido dentro da mesma transação'
    );
    assert.ok(
      commitEvent.queries.some(q => /character_inventory/i.test(q)),
      'a devolução ao inventário deveria usar a mesma conexão antes do commit'
    );
    assert.ok(
      commitEvent.queries.some(q => /INSERT INTO inventory_transactions/i.test(q)),
      'o ledger da devolução deveria estar na mesma transação'
    );
  });

  it('packStall abre transação e trava a barraca + os itens com FOR UPDATE', async () => {
    connEvents.length = 0;
    await marketStalls.packStall(OWNER_ACTOR_ID, STALL_ID);

    const commitEvent = connEvents.find(e => e.op === 'commit');
    assert.ok(commitEvent, 'packStall deveria ter commitado uma transação');
    const forUpdateCount = commitEvent.queries.filter(q => /FOR UPDATE/i.test(q)).length;
    assert.ok(forUpdateCount >= 2, 'packStall deveria travar tanto a barraca quanto os itens (>= 2 FOR UPDATE)');
    assert.ok(
      commitEvent.queries.some(q => /UPDATE market_stalls SET status/i.test(q)),
      'packStall deveria marcar a barraca como recolhida na mesma transação'
    );
    assert.ok(
      commitEvent.queries.some(q => /character_inventory/i.test(q)),
      'packStall deveria devolver o estoque na mesma transação'
    );
    assert.ok(
      commitEvent.queries.some(q => /INSERT INTO inventory_transactions/i.test(q)),
      'packStall deveria registrar o ledger antes do commit'
    );
  });

  it('addItem reverte a remoção do inventário se o anúncio falhar', async () => {
    connEvents.length = 0;
    failQueryPattern = /INSERT INTO market_stall_items/i;
    try {
      await marketStalls.addItem(OWNER_ACTOR_ID, STALL_ID, '0x1234', 3, 25, 'Item de teste');
    } finally {
      failQueryPattern = null;
    }

    assert.equal(connEvents.some(e => e.op === 'commit'), false);
    const rollbackEvent = connEvents.find(e => e.op === 'rollback');
    assert.ok(rollbackEvent, 'falha no anúncio deveria reverter toda a transação');
    assert.ok(
      rollbackEvent.queries.some(q => /character_inventory/i.test(q)),
      'a remoção da pilha precisa estar dentro da transação revertida'
    );
    assert.ok(
      rollbackEvent.queries.some(q => /INSERT INTO inventory_transactions/i.test(q)),
      'o ledger precisa estar dentro da transação revertida'
    );
    assert.ok(
      rollbackEvent.queries.some(q => /INSERT INTO market_stall_items/i.test(q)),
      'a falha forçada deve ocorrer depois da remoção e do ledger'
    );
  });
});
