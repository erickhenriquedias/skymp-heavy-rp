const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { planStackProjection } = require('./inventory-projection');

describe('inventory projection plan', () => {
  test('adiciona somente a diferenca para um stack SQL', () => {
    const plan = planStackProjection(
      [{ base_id: 0x12, count: 5 }],
      { entries: [{ baseId: 0x12, count: 2 }] }
    );
    assert.deepEqual(plan.additions, [{ baseId: 0x12, count: 3 }]);
    assert.deepEqual(plan.removals, []);
  });

  test('remove somente o excedente de um stack SQL', () => {
    const plan = planStackProjection(
      [{ base_id: 0x12, count: 5 }],
      { entries: [{ baseId: 0x12, count: 8 }] }
    );
    assert.deepEqual(plan.removals, [{ baseId: 0x12, count: 3 }]);
  });

  test('soma entradas nativas do mesmo baseId sem perder metadados no planejamento', () => {
    const plan = planStackProjection(
      [{ base_id: 0x12, count: 5 }],
      { entries: [
        { baseId: 0x12, count: 2, name: 'Comum' },
        { baseId: 0x12, count: 3, enchantmentId: 99 }
      ] }
    );
    assert.deepEqual(plan.additions, []);
    assert.deepEqual(plan.removals, []);
  });

  test('preserva baseId exclusivamente nativo e nao o importa', () => {
    const plan = planStackProjection(
      [{ base_id: 0x12, count: 1 }],
      { entries: [{ baseId: 0x12, count: 1 }, { baseId: 0x99, count: 7 }] }
    );
    assert.deepEqual(plan.additions, []);
    assert.deepEqual(plan.removals, []);
    assert.equal(plan.nativeOnlyStacks, 1);
  });

  test('remove por completo um baseId gerenciado cujo saldo SQL chegou a zero', () => {
    const plan = planStackProjection(
      [{ base_id: 0x12, count: 0 }],
      { entries: [{ baseId: 0x12, count: 4 }] }
    );
    assert.deepEqual(plan.removals, [{ baseId: 0x12, count: 4 }]);
    assert.equal(plan.nativeOnlyStacks, 0);
  });

  test('falha fechado se o snapshot nativo nao tem o contrato do upstream', () => {
    assert.throws(
      () => planStackProjection([{ base_id: 0x12, count: 1 }], undefined),
      /formato invalido/
    );
  });

  test('falha fechado com contagem SQL invalida', () => {
    assert.throws(
      () => planStackProjection([{ base_id: 0x12, count: -1 }], { entries: [] }),
      /count invalido/
    );
  });
});
