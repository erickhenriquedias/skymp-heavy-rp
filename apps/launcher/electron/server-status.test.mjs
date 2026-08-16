import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerStatus, offlineServerStatus } from './server-status.mjs';

test('normaliza o status público válido sem criar campos internos', () => {
  assert.deepEqual(normalizeServerStatus({
    state: 'online', players: 12, capacity: 100, queue: 3, message: null,
    ticket: 'não pode atravessar o IPC', checks: { database: 'ok' },
  }), {
    state: 'online', players: 12, capacity: 100, queue: 3, message: null,
  });
});

test('preserva os quatro estados publicados pela game-api', () => {
  for (const state of ['online', 'full', 'starting', 'maintenance']) {
    assert.equal(normalizeServerStatus({ state }).state, state);
  }
});

test('payload ausente ou estado desconhecido falha como offline', () => {
  assert.deepEqual(normalizeServerStatus(null), offlineServerStatus());
  assert.deepEqual(normalizeServerStatus({ state: 'database_error' }), offlineServerStatus());
});

test('contagens inválidas não chegam ao renderer', () => {
  const result = normalizeServerStatus({
    state: 'full', players: -1, capacity: '1000', queue: Number.MAX_SAFE_INTEGER + 1,
  });
  assert.equal(result.players, 0);
  assert.equal(result.capacity, 0);
  assert.equal(result.queue, 0);
});

test('mensagem pública é aparada e limitada', () => {
  const result = normalizeServerStatus({
    state: 'maintenance', message: `  ${'a'.repeat(200)}  `,
  });
  assert.equal(result.message.length, 160);
  assert.equal(result.message, 'a'.repeat(160));
});
