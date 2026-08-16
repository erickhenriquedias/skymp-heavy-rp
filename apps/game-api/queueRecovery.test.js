'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverQueueState } = require('./queueRecovery');

describe('recuperação da ocupação pelo MariaDB', () => {
  test('restaura conectados e reservas recentes sem recuperar token em claro', async () => {
    let restored;
    const calls = [];
    const summary = await recoverQueueState({
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return [
          {
            id: 11, account_id: 1, discord_id: 'discord-1', issued_at: new Date(1000),
            last_resolved_at: new Date(2000), connection_lease_hash: 'a'.repeat(64)
          },
          {
            id: 22, account_id: 2, discord_id: 'discord-2', issued_at: new Date(3000),
            last_resolved_at: null, connection_lease_hash: null
          },
          {
            id: 10, account_id: 1, discord_id: 'discord-1', issued_at: new Date(500),
            last_resolved_at: new Date(1500), connection_lease_hash: null
          }
        ];
      },
      queue: { restoreAdmissions: entries => { restored = entries; } },
      now: () => 10_000,
      reservationTtlMs: 3000
    });

    assert.match(calls[0].sql, /revoked_at IS NULL/);
    assert.match(calls[0].sql, /expires_at > NOW\(\)/);
    assert.match(calls[0].sql, /last_resolved_at IS NOT NULL OR issued_at > \?/);
    assert.equal(calls[0].params[0].getTime(), 7000);
    assert.deepEqual(restored, [
      {
        accountId: 1, discordId: 'discord-1', reservedAt: 2000, connected: true,
        sessionId: 11, leaseHash: 'a'.repeat(64)
      },
      {
        accountId: 2, discordId: 'discord-2', reservedAt: 3000, connected: false,
        sessionId: 22, leaseHash: null
      }
    ]);
    assert.deepEqual(summary, { accounts: 2, connected: 1, reservations: 1, sessionRows: 3 });
    assert.equal(Object.hasOwn(restored[0], 'sessionTicket'), false);
  });

  test('estado vazio é uma recuperação válida', async () => {
    let restored = null;
    const summary = await recoverQueueState({
      execute: async () => [],
      queue: { restoreAdmissions: entries => { restored = entries; } },
      reservationTtlMs: 1000
    });
    assert.deepEqual(restored, []);
    assert.deepEqual(summary, { accounts: 0, connected: 0, reservations: 0, sessionRows: 0 });
  });

  test('linha inválida falha fechado sem alterar a fila', async () => {
    let restored = false;
    await assert.rejects(
      recoverQueueState({
        execute: async () => [{
          id: 1, account_id: 'invalido', discord_id: 'discord', issued_at: new Date(),
          last_resolved_at: null, connection_lease_hash: null
        }],
        queue: { restoreAdmissions: () => { restored = true; } },
        reservationTtlMs: 1000
      }),
      /account_id inválido/
    );
    assert.equal(restored, false);
  });
});
