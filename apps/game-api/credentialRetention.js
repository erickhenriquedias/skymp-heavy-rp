'use strict';

const DEFAULTS = Object.freeze({
  launchTicketRetentionMs: 24 * 60 * 60 * 1000,
  gameSessionRetentionMs: 7 * 24 * 60 * 60 * 1000,
  batchSize: 500,
  maxBatches: 10
});

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} deve ser inteiro positivo`);
  }
  return value;
}

async function deleteExpiredInBatches({ execute, table, cutoff, batchSize, maxBatches }) {
  let deleted = 0;
  let batches = 0;
  let lastBatchSize = 0;

  // table não recebe entrada externa: os únicos chamadores ficam abaixo.
  const sql = `DELETE FROM ${table} WHERE expires_at < ? ORDER BY expires_at LIMIT ${batchSize}`;
  while (batches < maxBatches) {
    const result = await execute(sql, [cutoff]);
    lastBatchSize = Number(result?.affectedRows) || 0;
    deleted += lastBatchSize;
    batches += 1;
    if (lastBatchSize < batchSize) break;
  }

  return {
    deleted,
    batches,
    saturated: batches === maxBatches && lastBatchSize === batchSize
  };
}

async function cleanupExpiredCredentials({
  execute,
  now = Date.now,
  launchTicketRetentionMs = DEFAULTS.launchTicketRetentionMs,
  gameSessionRetentionMs = DEFAULTS.gameSessionRetentionMs,
  batchSize = DEFAULTS.batchSize,
  maxBatches = DEFAULTS.maxBatches
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('execute deve ser função');
  if (typeof now !== 'function') throw new TypeError('now deve ser função');
  requirePositiveInteger(launchTicketRetentionMs, 'launchTicketRetentionMs');
  requirePositiveInteger(gameSessionRetentionMs, 'gameSessionRetentionMs');
  requirePositiveInteger(batchSize, 'batchSize');
  requirePositiveInteger(maxBatches, 'maxBatches');

  const currentTime = now();
  const launchTickets = await deleteExpiredInBatches({
    execute,
    table: 'launch_tickets',
    cutoff: new Date(currentTime - launchTicketRetentionMs),
    batchSize,
    maxBatches
  });
  const gameSessions = await deleteExpiredInBatches({
    execute,
    table: 'game_sessions',
    cutoff: new Date(currentTime - gameSessionRetentionMs),
    batchSize,
    maxBatches
  });

  return { launchTickets, gameSessions };
}

function createCleanupScheduler({ cleanup, now = Date.now, intervalMs = 15 * 60 * 1000 } = {}) {
  if (typeof cleanup !== 'function') throw new TypeError('cleanup deve ser função');
  if (typeof now !== 'function') throw new TypeError('now deve ser função');
  requirePositiveInteger(intervalMs, 'intervalMs');

  let nextRunAt = now() + intervalMs;
  let running = null;

  function trigger({ force = false } = {}) {
    const currentTime = now();
    if (running || (!force && currentTime < nextRunAt)) return running;

    // Agenda antes de iniciar para que falha do MariaDB não transforme cada
    // requisição seguinte em uma nova tentativa de cleanup.
    nextRunAt = currentTime + intervalMs;
    running = Promise.resolve()
      .then(cleanup)
      .finally(() => { running = null; });
    return running;
  }

  return { trigger, isRunning: () => running !== null };
}

module.exports = {
  DEFAULTS,
  cleanupExpiredCredentials,
  createCleanupScheduler
};
