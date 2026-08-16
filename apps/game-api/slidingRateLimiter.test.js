'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSlidingWindowRateLimiter } = require('../../skymp/packages/sliding-rate-limiter');

function harness(options = {}) {
  let currentTime = 0;
  const limiter = createSlidingWindowRateLimiter({
    now: () => currentTime,
    sweepIntervalMs: 100,
    maxBuckets: 10,
    ...options
  });
  return {
    limiter,
    advance(milliseconds) { currentTime += milliseconds; }
  };
}

describe('rate limiter com memória limitada', () => {
  test('preserva a janela deslizante e limita somente depois do teto', () => {
    const { limiter } = harness();
    assert.equal(limiter.isLimited('ip:1', 2, 1000), false);
    assert.equal(limiter.isLimited('ip:1', 2, 1000), false);
    assert.equal(limiter.isLimited('ip:1', 2, 1000), true);
  });

  test('requisições já bloqueadas não aumentam o bucket indefinidamente', () => {
    const { limiter } = harness();
    assert.equal(limiter.isLimited('ip:1', 2, 1000), false);
    assert.equal(limiter.isLimited('ip:1', 2, 1000), false);
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(limiter.isLimited('ip:1', 2, 1000), true);
    }
    assert.equal(limiter.entrySize('ip:1'), 2);
  });

  test('requisições expiradas deixam de contar', () => {
    const { limiter, advance } = harness();
    assert.equal(limiter.isLimited('ip:1', 1, 50), false);
    assert.equal(limiter.isLimited('ip:1', 1, 50), true);
    advance(50);
    assert.equal(limiter.isLimited('ip:1', 1, 50), false);
  });

  test('sweep remove IP antigo mesmo que ele nunca volte', () => {
    const { limiter, advance } = harness();
    limiter.isLimited('abandonado', 5, 50);
    limiter.isLimited('ativo', 5, 1000);
    assert.equal(limiter.size(), 2);
    advance(100);
    limiter.isLimited('ativo', 5, 1000);
    assert.equal(limiter.size(), 1);
  });

  test('teto de buckets recusa chave nova quando todas continuam ativas', () => {
    const { limiter } = harness({ maxBuckets: 2 });
    assert.equal(limiter.isLimited('ip:1', 5, 1000), false);
    assert.equal(limiter.isLimited('ip:2', 5, 1000), false);
    assert.equal(limiter.isLimited('ip:3', 5, 1000), true);
    assert.equal(limiter.size(), 2);
  });

  test('teto primeiro limpa expirados e permite reutilizar capacidade', () => {
    const { limiter, advance } = harness({ maxBuckets: 1 });
    assert.equal(limiter.isLimited('ip:1', 5, 50), false);
    advance(100);
    assert.equal(limiter.isLimited('ip:2', 5, 50), false);
    assert.equal(limiter.size(), 1);
  });

  test('entrada ou configuração de chamada inválida falha fechado', () => {
    const { limiter } = harness();
    assert.equal(limiter.isLimited('', 5, 1000), true);
    assert.equal(limiter.isLimited('ip:1', 0, 1000), true);
    assert.equal(limiter.isLimited('ip:1', 5, 0), true);
    assert.equal(limiter.size(), 0);
  });
});
