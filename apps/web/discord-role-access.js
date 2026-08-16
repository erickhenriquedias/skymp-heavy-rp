'use strict';

function assertDiscordId(discordId) {
  if (!/^\d{5,32}$/.test(String(discordId || ''))) {
    throw new TypeError('discordId inválido');
  }
}

async function verifyDiscordRoleAccess({ botInternalUrl, internalSecret, discordId, fetchImpl = fetch }) {
  assertDiscordId(discordId);
  const response = await fetchImpl(`${botInternalUrl}/api/check-game-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': internalSecret
    },
    body: JSON.stringify({ discord_id: String(discordId) })
  });
  if (!response.ok) throw new Error(`bot respondeu HTTP ${response.status}`);
  const body = await response.json();
  return {
    eligible: body.eligible === true,
    matchedRoleId: typeof body.matched_role_id === 'string'
      ? body.matched_role_id.slice(0, 64)
      : null
  };
}

async function persistDiscordRoleAccess(pool, input) {
  assertDiscordId(input.discordId);
  if (!Number.isSafeInteger(Number(input.accountId)) || Number(input.accountId) <= 0) {
    throw new TypeError('accountId inválido');
  }
  const ttlSeconds = Math.max(60, Math.min(86400, Number(input.ttlSeconds) || 43200));
  const connection = await pool.getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;

    const [accounts] = await connection.execute(
      'SELECT id FROM accounts WHERE id = ? FOR UPDATE',
      [input.accountId]
    );
    if (accounts.length === 0) throw new Error('conta do Discord não encontrada');

    const [identities] = await connection.execute(
      'SELECT discord_id FROM discord_identities WHERE account_id = ? AND discord_id = ? FOR UPDATE',
      [input.accountId, String(input.discordId)]
    );
    if (identities.length === 0) throw new Error('Discord não pertence à conta informada');

    await connection.execute(
      `INSERT INTO discord_role_access
         (account_id, discord_id, eligible, matched_role_id, verified_at, expires_at)
       VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
         discord_id = VALUES(discord_id),
         eligible = VALUES(eligible),
         matched_role_id = VALUES(matched_role_id),
         verified_at = VALUES(verified_at),
         expires_at = VALUES(expires_at)`,
      [
        input.accountId,
        String(input.discordId),
        input.eligible ? 1 : 0,
        input.eligible ? input.matchedRoleId : null,
        input.eligible ? ttlSeconds : 0
      ]
    );

    let promoted = false;
    let revoked = false;
    if (input.eligible) {
      const [applications] = await connection.execute(
        `SELECT wa.id, wa.character_id, wa.status, wa.approval_source, c.status AS character_status
           FROM whitelist_applications wa
           INNER JOIN characters c ON c.id = wa.character_id AND c.account_id = wa.account_id
          WHERE wa.account_id = ? AND c.status <> 'retired'
          ORDER BY wa.id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.accountId]
      );
      const application = applications[0];
      if (application && application.status !== 'approved') {
        await connection.execute(
          `UPDATE whitelist_applications
              SET status = 'approved', approval_source = 'discord_role',
                  reviewed_by = 'Discord role', reviewed_at = NOW()
            WHERE id = ?`,
          [application.id]
        );
        if (application.character_status !== 'approved') {
          await connection.execute(
            `UPDATE characters SET status = 'approved'
              WHERE id = ? AND account_id = ? AND status <> 'retired'`,
            [application.character_id, input.accountId]
          );
        }
        await connection.execute(
          `INSERT INTO audit_logs (action, target_account_id, details)
           VALUES ('whitelist:discord_role_grant', ?, ?)`,
          [input.accountId, `role:${input.matchedRoleId || 'configured'}`]
        );
        promoted = true;
      }
    } else {
      const [roleApplications] = await connection.execute(
        `SELECT wa.id, wa.character_id, c.status AS character_status
           FROM whitelist_applications wa
           INNER JOIN characters c ON c.id = wa.character_id AND c.account_id = wa.account_id
          WHERE wa.account_id = ?
            AND wa.status = 'approved'
            AND wa.approval_source = 'discord_role'
          ORDER BY wa.id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.accountId]
      );
      const application = roleApplications[0];
      if (application) {
        await connection.execute(
          `UPDATE whitelist_applications
              SET status = 'pending', approval_source = NULL,
                  reviewer_notes = 'Cargo de acesso do Discord removido ou expirado',
                  reviewed_by = 'Discord role', reviewed_at = NOW()
            WHERE id = ? AND approval_source = 'discord_role'`,
          [application.id]
        );
        if (application.character_status === 'approved') {
          await connection.execute(
            `UPDATE characters SET status = 'pending'
              WHERE id = ? AND account_id = ? AND status = 'approved'`,
            [application.character_id, input.accountId]
          );
        }
        await connection.execute(
          `INSERT INTO audit_logs (action, target_account_id, details)
           VALUES ('whitelist:discord_role_revoke', ?, 'eligible role absent')`,
          [input.accountId]
        );
        revoked = true;
      }
    }

    await connection.commit();
    started = false;
    return { eligible: Boolean(input.eligible), promoted, revoked };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { verifyDiscordRoleAccess, persistDiscordRoleAccess };
