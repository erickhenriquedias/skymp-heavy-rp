'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanupExpiredCredentials,
  createCleanupScheduler
} = require('./credentialRetention');

describe('retenção de credenciais no MariaDB', () => {
  test('remove tickets e sessões por expires_at com retenções distintas', async () => {
    const calls = [];
    const results = [{ affectedRows: 2 }, { affectedRows: 0 }];
    const summary = await cleanupExpiredCredentials({
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return results.shift();
      },
      now: () => Date.UTC(2026, 7, 16, 12),
      launchTicketRetentionMs: 1000,
      gameSessionRetentionMs: 2000,
      batchSize: 10,
      maxBatches: 2
    });

    assert.match(calls[0].sql, /^DELETE FROM launch_tickets WHERE expires_at < \?/);
    assert.match(calls[1].sql, /^DELETE FROM game_sessions WHERE expires_at < \?/);
    assert.equal(calls[0].params[0].toISOString(), '2026-08-16T11:59:59.000Z');
    assert.equal(calls[1].params[0].toISOString(), '2026-08-16T11:59:58.000Z');
    assert.equal(summary.launchTickets.deleted, 2);
    assert.equal(summary.gameSessions.deleted, 0);
  });

  test('continua em lotes até encontrar lote incompleto', async () => {
    const affectedRows = [3, 3, 1, 0];
    const summary = await cleanupExpiredCredentials({
      execute: async () => ({ affectedRows: affectedRows.shift() }),
      batchSize: 3,
      maxBatches: 5
    });

    assert.deepEqual(summary.launchTickets, { deleted: 7, batches: 3, saturated: false });
    assert.deepEqual(summary.gameSessions, { deleted: 0, batches: 1, saturated: false });
  });

  test('interrompe backlog no máximo de lotes e sinaliza saturação', async () => {
    const summary = await cleanupExpiredCredentials({
      execute: async () => ({ affectedRows: 5 }),
      batchSize: 5,
      maxBatches: 2
    });

    assert.deepEqual(summary.launchTickets, { deleted: 10, batches: 2, saturated: true });
    assert.deepEqual(summary.gameSessions, { deleted: 10, batches: 2, saturated: true });
  });

  test('configuração inválida falha antes de executar SQL', async () => {
    let executions = 0;
    await assert.rejects(
      cleanupExpiredCredentials({
        execute: async () => { executions += 1; },
        batchSize: 0
      }),
      /batchSize deve ser inteiro positivo/
    );
    assert.equal(executions, 0);
  });
});

describe('agendamento oportunista da retenção', () => {
  test('não executa antes do intervalo e aceita execução forçada no boot', async () => {
    let runs = 0;
    const scheduler = createCleanupScheduler({
      cleanup: async () => { runs += 1; },
      now: () => 1000,
      intervalMs: 500
    });

    assert.equal(scheduler.trigger(), null);
    await scheduler.trigger({ force: true });
    assert.equal(runs, 1);
  });

  test('deduplica execuções concorrentes', async () => {
    let release;
    let runs = 0;
    const scheduler = createCleanupScheduler({
      cleanup: () => {
        runs += 1;
        return new Promise(resolve => { release = resolve; });
      },
      now: () => 1000,
      intervalMs: 500
    });

    const first = scheduler.trigger({ force: true });
    const second = scheduler.trigger({ force: true });
    assert.equal(first, second);
    await Promise.resolve();
    release();
    await first;
    assert.equal(runs, 1);
    assert.equal(scheduler.isRunning(), false);
  });
});
