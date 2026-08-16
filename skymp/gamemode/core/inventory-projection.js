'use strict';

const MAX_FORM_ID = 0xffffffff;
const MAX_STACK_COUNT = 0x7fffffff;

function validBaseId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_FORM_ID) {
    throw new Error(`${label}: baseId invalido (${JSON.stringify(value)})`);
  }
  return parsed;
}

function validCount(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_STACK_COUNT) {
    throw new Error(`${label}: count invalido (${JSON.stringify(value)})`);
  }
  return parsed;
}

function addCount(map, baseId, count, label) {
  const next = (map.get(baseId) || 0) + count;
  if (!Number.isSafeInteger(next) || next > MAX_STACK_COUNT) {
    throw new Error(`${label}: soma excede o limite para 0x${baseId.toString(16)}`);
  }
  map.set(baseId, next);
}

function sqlStacks(rows) {
  if (!Array.isArray(rows)) throw new Error('snapshot SQL de inventario nao e uma lista');
  const result = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') throw new Error(`SQL[${index}]: stack invalida`);
    const baseId = validBaseId(row.base_id, `SQL[${index}]`);
    // Zero representa um baseId que ja foi gerenciado e hoje nao deve existir.
    // Ele vem do ledger quando a linha atual foi removida de character_inventory.
    const count = validCount(row.count, `SQL[${index}]`, { allowZero: true });
    addCount(result, baseId, count, 'SQL');
  }
  return result;
}

function nativeStacks(inventory) {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.entries)) {
    throw new Error("mp.get(actorId, 'inventory') devolveu formato invalido");
  }
  const result = new Map();
  for (const [index, entry] of inventory.entries.entries()) {
    if (!entry || typeof entry !== 'object') throw new Error(`native[${index}]: stack invalida`);
    const baseId = validBaseId(entry.baseId, `native[${index}]`);
    const count = validCount(entry.count, `native[${index}]`, { allowZero: true });
    if (count > 0) addCount(result, baseId, count, 'native');
  }
  return result;
}

/**
 * Faz os baseIds conhecidos pelo MariaDB convergirem para a contagem absoluta.
 * BaseIds que existem somente no change form sao preservados nesta fase de
 * compatibilidade vanilla; eles nunca sao importados para o banco.
 */
function planStackProjection(rows, inventory) {
  const desired = sqlStacks(rows);
  const current = nativeStacks(inventory);
  const removals = [];
  const additions = [];

  for (const [baseId, desiredCount] of desired) {
    const delta = desiredCount - (current.get(baseId) || 0);
    if (delta > 0) additions.push({ baseId, count: delta });
    if (delta < 0) removals.push({ baseId, count: Math.abs(delta) });
  }

  const byBaseId = (left, right) => left.baseId - right.baseId;
  additions.sort(byBaseId);
  removals.sort(byBaseId);

  return {
    additions,
    removals,
    managedStacks: desired.size,
    nativeOnlyStacks: [...current.keys()].filter(baseId => !desired.has(baseId)).length
  };
}

module.exports = {
  MAX_FORM_ID,
  MAX_STACK_COUNT,
  sqlStacks,
  nativeStacks,
  planStackProjection
};
