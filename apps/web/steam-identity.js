'use strict';

const STEAM_ID64 = /^7656119\d{10}$/;

function verifiedSteamConnection(connections) {
  if (!Array.isArray(connections)) return null;
  const connection = connections.find(item =>
    item && item.type === 'steam' && item.verified === true && STEAM_ID64.test(String(item.id || ''))
  );
  if (!connection) return null;
  return {
    steamId: String(connection.id),
    displayName: typeof connection.name === 'string' ? connection.name.trim().slice(0, 128) || null : null
  };
}

async function persistObservedSteamIdentity({ pool, accountId, connections }) {
  const steam = verifiedSteamConnection(connections);
  if (!steam) return { linked: false, reason: 'not_available', steamId: null };
  if (!Number.isSafeInteger(Number(accountId)) || Number(accountId) <= 0) {
    throw new TypeError('accountId invalido');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT steam_id, account_id
         FROM steam_identities
        WHERE steam_id = ? OR account_id = ?
        FOR UPDATE`,
      [steam.steamId, Number(accountId)]
    );

    const conflictingSteam = rows.find(row =>
      String(row.steam_id) === steam.steamId && Number(row.account_id) !== Number(accountId)
    );
    if (conflictingSteam) {
      await connection.rollback();
      return { linked: false, reason: 'already_linked', steamId: null };
    }

    const current = rows.find(row => Number(row.account_id) === Number(accountId));
    if (current) {
      await connection.execute(
        `UPDATE steam_identities
            SET steam_id = ?, display_name = ?, last_verified_at = CURRENT_TIMESTAMP
          WHERE account_id = ? AND steam_id = ?`,
        [steam.steamId, steam.displayName, Number(accountId), String(current.steam_id)]
      );
    } else {
      await connection.execute(
        `INSERT INTO steam_identities
           (steam_id, account_id, display_name, source, last_verified_at)
         VALUES (?, ?, ?, 'discord_connection', CURRENT_TIMESTAMP)`,
        [steam.steamId, Number(accountId), steam.displayName]
      );
    }

    await connection.commit();
    return { linked: true, reason: 'verified_discord_connection', steamId: steam.steamId };
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

async function fetchDiscordConnections(accessToken, fetchImpl = fetch, logger = console) {
  try {
    const response = await fetchImpl('https://discord.com/api/users/@me/connections', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      logger.error('[steam-identity] Discord não retornou conexões vinculadas.');
      return [];
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    logger.error(`[steam-identity] Consulta de conexões indisponível: ${error.message}`);
    return [];
  }
}

module.exports = {
  STEAM_ID64,
  verifiedSteamConnection,
  persistObservedSteamIdentity,
  fetchDiscordConnections
};
