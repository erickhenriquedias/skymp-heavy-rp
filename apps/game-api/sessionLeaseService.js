'use strict';

function createSessionLeaseService({ execute, queue, hashToken, makeToken, makeSessionTicket }) {
  if (typeof execute !== 'function') throw new TypeError('execute deve ser função');
  if (!queue || typeof queue.getAdmission !== 'function') throw new TypeError('queue inválida');
  if (typeof hashToken !== 'function' || typeof makeToken !== 'function') throw new TypeError('geradores inválidos');

  const locks = new Map();

  function withAccountLock(accountId, operation) {
    const previous = locks.get(accountId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(accountId, current);
    return current.finally(() => {
      if (locks.get(accountId) === current) locks.delete(accountId);
    });
  }

  async function confirmConnected(accountId, sessionId) {
    return withAccountLock(accountId, async () => {
      const rows = await execute(
        `SELECT id FROM game_sessions
          WHERE account_id = ? AND revoked_at IS NULL AND disconnected_at IS NULL
            AND expires_at > NOW()
          ORDER BY last_resolved_at DESC, id DESC LIMIT 1`,
        [accountId]
      );
      if (!Array.isArray(rows) || Number(rows[0]?.id) !== sessionId) {
        return { ok: false, reason: 'stale_session' };
      }
      if (!queue.confirmSessionConnected(accountId, sessionId)) {
        return { ok: false, reason: 'admission_not_found' };
      }
      return { ok: true };
    });
  }

  async function claim(accountId) {
    return withAccountLock(accountId, async () => {
      const admission = queue.getAdmission(accountId);
      if (!admission || !admission.connected || !Number.isSafeInteger(admission.sessionId)) {
        return { ok: false, reason: 'connected_admission_not_found' };
      }

      const token = makeToken();
      const leaseHash = hashToken(token);
      const result = await execute(
        `UPDATE game_sessions
            SET connection_lease_hash = ?, connected_at = NOW(6), disconnected_at = NULL
          WHERE id = ? AND account_id = ? AND revoked_at IS NULL
            AND disconnected_at IS NULL AND expires_at > NOW()`,
        [leaseHash, admission.sessionId, accountId]
      );
      if (Number(result?.affectedRows) !== 1) return { ok: false, reason: 'session_not_active' };

      if (!queue.setConnectionLease(accountId, admission.sessionId, leaseHash)) {
        await execute(
          'UPDATE game_sessions SET connection_lease_hash = NULL WHERE id = ? AND connection_lease_hash = ?',
          [admission.sessionId, leaseHash]
        );
        return { ok: false, reason: 'admission_changed' };
      }
      return { ok: true, leaseToken: token };
    });
  }

  async function release(leaseToken) {
    if (typeof leaseToken !== 'string' || leaseToken.length < 32) {
      return { ok: false, released: false, reason: 'invalid_lease' };
    }
    const leaseHash = hashToken(leaseToken);
    const result = await execute(
      `UPDATE game_sessions
          SET revoked_at = NOW(), disconnected_at = NOW(6), connection_lease_hash = NULL
        WHERE connection_lease_hash = ? AND revoked_at IS NULL AND disconnected_at IS NULL`,
      [leaseHash]
    );
    if (Number(result?.affectedRows) !== 1) {
      return { ok: true, released: false, stale: true };
    }
    const released = queue.releaseByLeaseHash(leaseHash, makeSessionTicket);
    return { ok: true, released };
  }

  return { confirmConnected, claim, release, activeLocks: () => locks.size };
}

module.exports = { createSessionLeaseService };
