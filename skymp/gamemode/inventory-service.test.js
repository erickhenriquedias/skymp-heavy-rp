const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const db = require('./database');
const inventoryService = require('./inventory-service');

const originalQuery = db.query;
const originalMp = global.mp;
let rows;
let nativeInventory;
let calls;
let applyCalls;

function applyNative(functionName, args) {
  const baseId = args[0];
  const amount = args[1];
  let entry = nativeInventory.entries.find(item => item.baseId === baseId);
  if (!applyCalls) return;
  if (functionName === 'AddItem') {
    if (!entry) {
      entry = { baseId, count: 0 };
      nativeInventory.entries.push(entry);
    }
    entry.count += amount;
  } else if (functionName === 'RemoveItem') {
    entry.count -= amount;
    if (entry.count === 0) nativeInventory.entries = nativeInventory.entries.filter(item => item !== entry);
  }
}

beforeEach(() => {
  rows = [{ base_id: 0x12, count: 5 }];
  nativeInventory = { entries: [{ baseId: 0x12, count: 2 }] };
  calls = [];
  applyCalls = true;
  db.query = async () => rows;
  global.mp = {
    getDescFromId(formId) { return `form:${formId.toString(16)}`; },
    get(actorId, property) {
      assert.equal(actorId, 0xff001234);
      assert.equal(property, 'inventory');
      return nativeInventory;
    },
    callPapyrusFunction(callType, className, functionName, self, args) {
      calls.push({ callType, className, functionName, self, args });
      applyNative(functionName, args);
    }
  };
});

afterEach(() => {
  db.query = originalQuery;
  if (originalMp === undefined) delete global.mp;
  else global.mp = originalMp;
});

describe('inventory-service absolute projection', () => {
  test('reconnect nao repete AddItem quando o change form ja tem a contagem', async () => {
    const first = await inventoryService.syncInventoryToClient(0xff001234, 77);
    const second = await inventoryService.syncInventoryToClient(0xff001234, 77);

    assert.equal(first.additions, 1);
    assert.equal(second.additions, 0);
    assert.deepEqual(calls.map(call => [call.functionName, call.args[0], call.args[1]]), [
      ['AddItem', 0x12, 3]
    ]);
  });

  test('duas sincronizacoes concorrentes sao serializadas por personagem', async () => {
    await Promise.all([
      inventoryService.syncInventoryToClient(0xff001234, 77),
      inventoryService.syncInventoryToClient(0xff001234, 77)
    ]);
    assert.equal(calls.filter(call => call.functionName === 'AddItem').length, 1);
  });

  test('remove excedente gerenciado sem apagar item exclusivamente nativo', async () => {
    nativeInventory = {
      entries: [{ baseId: 0x12, count: 8 }, { baseId: 0x99, count: 4, name: 'Quest' }]
    };
    const result = await inventoryService.syncInventoryToClient(0xff001234, 77);

    assert.deepEqual(calls.map(call => [call.functionName, call.args[0], call.args[1]]), [
      ['RemoveItem', 0x12, 3]
    ]);
    assert.equal(result.nativeOnlyStacks, 1);
    assert.equal(nativeInventory.entries.find(item => item.baseId === 0x99).count, 4);
  });

  test('snapshot nativo desconhecido reprova em vez de executar AddItem cego', async () => {
    nativeInventory = undefined;
    await assert.rejects(
      inventoryService.syncInventoryToClient(0xff001234, 77),
      /formato invalido/
    );
    assert.deepEqual(calls, []);
  });

  test('binding que ignora a mutacao reprova a admissao em vez de fingir sync', async () => {
    applyCalls = false;
    await assert.rejects(
      inventoryService.syncInventoryToClient(0xff001234, 77),
      /projecao nao convergiu/
    );
    assert.equal(calls.length, 1, 'a tentativa foi feita e detectada pela releitura');
  });
});
