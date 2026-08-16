'use strict';

function asDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} inválido na recuperação da fila`);
  return date;
}

async function recoverQueueState({ execute, queue, now = Date.now, reservationTtlMs }) {
  if (typeof execute !== 'function') throw new TypeError('execute deve ser função');
  if (!queue || typeof queue.restoreAdmissions !== 'function') {
    throw new TypeError('queue deve suportar restoreAdmissions');
  }
  if (typeof now !== 'function') throw new TypeError('now deve ser função');
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new TypeError('reservationTtlMs deve ser inteiro positivo');
  }

  const reservationCutoff = new Date(now() - reservationTtlMs);
  const rows = await execute(
    `SELECT id, account_id, discord_id, issued_at, last_resolved_at,
            connection_lease_hash
       FROM game_sessions
      WHERE revoked_at IS NULL
        AND disconnected_at IS NULL
        AND expires_at > NOW()
        AND (last_resolved_at IS NOT NULL OR issued_at > ?)
      ORDER BY account_id,
               (last_resolved_at IS NOT NULL) DESC,
               COALESCE(last_resolved_at, issued_at) DESC,
               id DESC`,
    [reservationCutoff]
  );
  if (!Array.isArray(rows)) throw new TypeError('consulta de recuperação deve retornar array');

  const admissions = [];
  const seenAccounts = new Set();
  for (const row of rows) {
    const accountId = Number(row.account_id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new TypeError('account_id inválido na recuperação da fila');
    }
    if (typeof row.discord_id !== 'string' || row.discord_id.length === 0 || row.discord_id.length > 64) {
      throw new TypeError('discord_id inválido na recuperação da fila');
    }
    const sessionId = Number(row.id);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new TypeError('session id inválido na recuperação da fila');
    }
    if (row.connection_lease_hash !== null && row.connection_lease_hash !== undefined &&
      (typeof row.connection_lease_hash !== 'string' || row.connection_lease_hash.length !== 64)) {
      throw new TypeError('connection_lease_hash inválido na recuperação da fila');
    }
    if (seenAccounts.has(accountId)) continue;
    seenAccounts.add(accountId);
    const connected = row.last_resolved_at !== null && row.last_resolved_at !== undefined;
    admissions.push({
      accountId,
      discordId: row.discord_id,
      reservedAt: asDate(connected ? row.last_resolved_at : row.issued_at, connected ? 'last_resolved_at' : 'issued_at').getTime(),
      connected,
      sessionId,
      leaseHash: row.connection_lease_hash || null
    });
  }

  queue.restoreAdmissions(admissions);
  return {
    accounts: admissions.length,
    connected: admissions.filter(entry => entry.connected).length,
    reservations: admissions.filter(entry => !entry.connected).length,
    sessionRows: rows.length
  };
}

module.exports = { recoverQueueState };
