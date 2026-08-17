'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const { assertServerLoadOrder, validateServerLoadOrder } = require('./load-order-gate');

const expected = ['Skyrim.esm', 'Update.esm', 'HeavyRP.esp'];

describe('gate server-side de load order', () => {
  test('aprova somente configuração, manifesto e ordem efetiva idênticos', () => {
    assert.deepEqual(validateServerLoadOrder({
      manifestLoadOrder: expected,
      configuredLoadOrder: ['skyrim.ESM', 'Update.esm', 'HeavyRP.esp'],
      effectiveLoadOrder: expected,
    }), { ok: true });
  });

  test('recusa plugin ausente, extra e fora de ordem com índice explícito', () => {
    const missing = validateServerLoadOrder({
      manifestLoadOrder: expected, configuredLoadOrder: expected,
      effectiveLoadOrder: ['Skyrim.esm', 'Update.esm'],
    });
    assert.equal(missing.ok, false);
    assert.match(missing.problems[0], /possui 2 plugin/);

    const reordered = validateServerLoadOrder({
      manifestLoadOrder: expected,
      configuredLoadOrder: ['Skyrim.esm', 'HeavyRP.esp', 'Update.esm'],
      effectiveLoadOrder: expected,
    });
    assert.equal(reordered.ok, false);
    assert.match(reordered.problems[0], /\[1\].*HeavyRP\.esp.*Update\.esm/);
  });

  test('recusa arrays vazios, paths e duplicação por diferença de caixa', () => {
    for (const actual of [[], ['Data/Skyrim.esm'], ['Skyrim.esm', 'skyrim.ESM']]) {
      const result = validateServerLoadOrder({
        manifestLoadOrder: expected, configuredLoadOrder: expected, effectiveLoadOrder: actual,
      });
      assert.equal(result.ok, false);
    }
  });

  test('assert falha fechado e inclui todas as fronteiras divergentes', () => {
    assert.throws(() => assertServerLoadOrder({
      manifestLoadOrder: expected,
      configuredLoadOrder: ['Skyrim.esm'],
      effectiveLoadOrder: ['Update.esm'],
    }), /server-settings.*mp\.getEspmLoadOrder/);
  });

  test('entrypoint executa o gate antes de abrir banco ou runtime', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'phase0-basic.js'), 'utf8');
    const gate = source.indexOf('assertServerLoadOrder({');
    assert.ok(gate > 0, 'gate não foi ligado ao boot');
    assert.ok(gate < source.indexOf('db.init();'), 'gate precisa acontecer antes do banco');
    assert.ok(gate < source.indexOf('startRuntime();'), 'gate precisa acontecer antes do runtime');
    assert.match(source, /createManifestLoader\(manifestPath/);
    assert.match(source, /mp\.getEspmLoadOrder\(\)/);
  });
});
