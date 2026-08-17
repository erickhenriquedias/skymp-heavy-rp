'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getBotReadiness } = require('./bot-readiness');

test('readiness do bot exige sessao Discord realmente pronta', () => {
  assert.deepEqual(getBotReadiness({ isReady: () => false }), {
    ready: false,
    checks: { discord: false },
  });
  assert.deepEqual(getBotReadiness({ isReady: () => true }), {
    ready: true,
    checks: { discord: true },
  });
});

test('cliente ausente ou sem API conhecida falha fechado', () => {
  assert.deepEqual(getBotReadiness(null), { ready: false, checks: { discord: false } });
  assert.deepEqual(getBotReadiness({}), { ready: false, checks: { discord: false } });
});
