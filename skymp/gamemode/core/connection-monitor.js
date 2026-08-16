/**
 * Ciclo de conexao orientado pelos eventos nativos do SkyMP.
 *
 * O evento `connect` acontece antes de o ator necessariamente existir. Por
 * isso apenas sessoes pendentes recebem retry; nao existe scan periodico de
 * todos os slots nem busca linear de profileId.
 */

'use strict';

const DEFAULT_RETRY_INTERVAL_MS = 2000;

function positiveIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {{
 *   mp: {on: Function, isConnected: Function, getUserActor: Function, getUserGuid?: Function, get: Function, getServerSettings: Function, kick: Function},
 *   whitelist: {checkWhitelist: Function},
 *   commands: {removeActiveCharacter: Function},
 *   playerPanel: {cleanup: Function},
 *   sessionLeaseClient?: {claim: Function, release: Function},
 *   requireSessionLease?: boolean,
 *   logger?: Pick<Console, 'log'|'warn'|'error'>,
 *   retryIntervalMs?: number
 * }} dependencies
 */
function createConnectionMonitor({
  mp,
  whitelist,
  commands,
  playerPanel,
  sessionLeaseClient,
  requireSessionLease = true,
  logger = console,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS
}) {
  if (!mp || typeof mp.on !== 'function' || typeof mp.isConnected !== 'function' ||
    typeof mp.getUserActor !== 'function' || typeof mp.get !== 'function' ||
    typeof mp.getServerSettings !== 'function' || typeof mp.kick !== 'function') {
    throw new Error('[connection-monitor] mp invalido');
  }
  if (!whitelist || typeof whitelist.checkWhitelist !== 'function') {
    throw new Error('[connection-monitor] whitelist invalida');
  }
  if (!commands || typeof commands.removeActiveCharacter !== 'function') {
    throw new Error('[connection-monitor] commands invalido');
  }
  if (!playerPanel || typeof playerPanel.cleanup !== 'function') {
    throw new Error('[connection-monitor] playerPanel invalido');
  }
  if (requireSessionLease && (!sessionLeaseClient ||
    typeof sessionLeaseClient.claim !== 'function' ||
    typeof sessionLeaseClient.release !== 'function')) {
    throw new Error('[connection-monitor] sessionLeaseClient invalido');
  }

  const retryDelay = positiveIntegerOr(retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
  /** @type {Map<number, {id: number, guid: string|null, actorId: number|null, accountId: number|null, leaseToken: string|null, leaseReleased: boolean, verificationPending: boolean, approved: boolean, rejected: boolean, cleaned: boolean, missingProfileReported: boolean, retryTimer: ReturnType<typeof setTimeout>|null}>} */
  const sessions = new Map();
  const userIdByAccount = new Map();
  let nextSessionId = 1;
  let active = false;
  let listenersInstalled = false;

  function connectionGuid(userId) {
    if (typeof mp.getUserGuid !== 'function') return null;
    try {
      const guid = mp.getUserGuid(userId);
      return typeof guid === 'string' && guid.length > 0 ? guid : null;
    } catch (_) {
      return null;
    }
  }

  function isCurrent(userId, session) {
    return sessions.get(userId) === session;
  }

  function clearRetry(session) {
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }

  function releaseLeaseToken(leaseToken, context) {
    if (!requireSessionLease || !leaseToken) return;
    Promise.resolve(sessionLeaseClient.release(leaseToken)).catch(err => {
      logger.error(`[phase0] Failed to release connection lease (${context}):`, err.message);
    });
  }

  function cleanup(userId, session, reason) {
    if (session.cleaned) return;
    session.cleaned = true;
    clearRetry(session);
    if (session.accountId !== null && userIdByAccount.get(session.accountId) === userId) {
      userIdByAccount.delete(session.accountId);
    }
    if (!session.leaseReleased && session.leaseToken) {
      session.leaseReleased = true;
      const leaseToken = session.leaseToken;
      session.leaseToken = null;
      releaseLeaseToken(leaseToken, `${reason} user ${userId}`);
    }
    if (!session.actorId) return;

    try {
      commands.removeActiveCharacter(session.actorId);
    } catch (err) {
      logger.error(`[phase0] Error removing active character for ${reason} user ${userId}:`, err.message);
    }
    try {
      playerPanel.cleanup(session.actorId);
    } catch (err) {
      logger.error(`[phase0] Error cleaning player panel for ${reason} user ${userId}:`, err.message);
    }
  }

  function disconnect(userId, reason = 'disconnected') {
    const session = sessions.get(userId);
    if (!session) return;
    sessions.delete(userId);
    logger.log(`[phase0] Disconnection detected! User ID: ${userId}`);
    cleanup(userId, session, reason);
  }

  function reject(userId, session, reason, kick) {
    if (!isCurrent(userId, session) || session.rejected) return;
    session.rejected = true;
    clearRetry(session);
    if (kick) {
      try {
        mp.kick(userId);
      } catch (err) {
        logger.error(`[phase0] Failed to kick user ${userId}:`, err.message);
      }
    }
    cleanup(userId, session, reason);
  }

  function sameConnection(userId, session) {
    try {
      if (!isCurrent(userId, session) || !mp.isConnected(userId)) return false;
      if (session.guid === null) return true;
      return connectionGuid(userId) === session.guid;
    } catch (_) {
      return false;
    }
  }

  function verify(userId, session, profileId) {
    clearRetry(session);
    session.verificationPending = true;
    const stale = Symbol('stale connection');
    const leaseClaim = requireSessionLease
      ? Promise.resolve(sessionLeaseClient.claim(profileId))
      : Promise.resolve(null);

    leaseClaim
      .then(leaseToken => {
        if (!isCurrent(userId, session) || !sameConnection(userId, session)) {
          releaseLeaseToken(leaseToken, `stale claim user ${userId}`);
          return stale;
        }
        if (requireSessionLease && (typeof leaseToken !== 'string' || leaseToken.length < 32)) {
          throw new Error('game-api devolveu lease inválido');
        }

        session.accountId = profileId;
        session.leaseToken = leaseToken;
        const previousUserId = userIdByAccount.get(profileId);
        userIdByAccount.set(profileId, userId);
        if (previousUserId !== undefined && previousUserId !== userId) {
          const previous = sessions.get(previousUserId);
          if (previous) reject(previousUserId, previous, 'account superseded', true);
        }
        return Promise.resolve(whitelist.checkWhitelist(userId, profileId, session.actorId));
      })
      .then(allowed => {
        if (allowed === stale) return;
        if (!isCurrent(userId, session) || session.rejected || session.cleaned) return;
        if (!sameConnection(userId, session)) {
          disconnect(userId, 'stale connection');
          return;
        }

        session.verificationPending = false;
        if (allowed) {
          session.approved = true;
          logger.log(`[phase0] User ${userId} successfully approved by database check.`);
          return;
        }
        logger.log(`[phase0] User ${userId} was rejected by database check.`);
        // checkWhitelist ja solicita o kick nas recusas conhecidas.
        reject(userId, session, 'rejected', false);
      })
      .catch(err => {
        if (!isCurrent(userId, session) || session.rejected || session.cleaned) return;
        if (!sameConnection(userId, session)) {
          disconnect(userId, 'stale connection');
          return;
        }
        session.verificationPending = false;
        logger.error(`[phase0] Error in async checkWhitelist for user ${userId}:`, err.message);
        reject(userId, session, 'failed whitelist', true);
      });
  }

  function scheduleRetry(userId, session) {
    if (!active || !isCurrent(userId, session) || session.retryTimer ||
      session.verificationPending || session.approved || session.rejected) return;

    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      processConnectedUser(userId, session);
    }, retryDelay);
    if (typeof session.retryTimer.unref === 'function') session.retryTimer.unref();
  }

  function processConnectedUser(userId, session) {
    if (!active || !isCurrent(userId, session) || session.rejected ||
      session.approved || session.verificationPending) return;

    try {
      if (!sameConnection(userId, session)) {
        disconnect(userId, 'stale connection');
        return;
      }

      const actorId = mp.getUserActor(userId);
      if (!actorId) {
        scheduleRetry(userId, session);
        return;
      }
      session.actorId = actorId;

      // `profileId` e uma property nativa no proprio ator. Le-la e O(1);
      // varrer 1..N com getActorsByProfileId era incompleto e custoso.
      const profileId = mp.get(actorId, 'profileId');
      if (!Number.isSafeInteger(profileId) || profileId <= 0) {
        if (!session.missingProfileReported) {
          session.missingProfileReported = true;
          logger.warn(`[phase0] User ${userId} actor ${actorId.toString(16)} has no associated profileId yet.`);
        }
        scheduleRetry(userId, session);
        return;
      }

      session.missingProfileReported = false;
      logger.log(`[phase0] User ${userId} mapped to profileId: ${profileId}`);
      verify(userId, session, profileId);
    } catch (err) {
      logger.error(`[phase0] Error processing connection for user ${userId}:`, err.message);
      reject(userId, session, 'connection processing', true);
    }
  }

  function connect(userId) {
    if (!active || !Number.isSafeInteger(userId) || userId < 0) return;

    const guid = connectionGuid(userId);
    const existing = sessions.get(userId);
    if (existing) {
      if (existing.guid === guid || guid === null) {
        processConnectedUser(userId, existing);
        return;
      }
      disconnect(userId, 'replaced connection');
    }

    const session = {
      id: nextSessionId++, guid, actorId: null, accountId: null,
      leaseToken: null, leaseReleased: false, verificationPending: false,
      approved: false, rejected: false, cleaned: false,
      missingProfileReported: false, retryTimer: null
    };
    sessions.set(userId, session);
    logger.log(`[phase0] Connection detected! User ID: ${userId}, session: ${session.id}`);
    processConnectedUser(userId, session);
  }

  function reconcileExistingConnections() {
    let settings;
    try {
      settings = mp.getServerSettings();
    } catch (err) {
      logger.warn('[phase0] Could not reconcile existing connections:', err.message);
      return;
    }

    const maxPlayers = settings && Number(settings.maxPlayers);
    if (!Number.isSafeInteger(maxPlayers) || maxPlayers <= 0) {
      logger.warn('[phase0] Could not reconcile existing connections: maxPlayers invalido');
      return;
    }

    // Varredura unica para hot reload/registro tardio. O fluxo normal depois
    // daqui e inteiramente dirigido pelos eventos connect/disconnect.
    for (let userId = 0; userId < maxPlayers; userId++) {
      try {
        if (mp.isConnected(userId)) connect(userId);
      } catch (err) {
        logger.warn(`[phase0] Could not inspect user ${userId} during reconciliation:`, err.message);
      }
    }
  }

  function tick() {
    for (const [userId, session] of sessions) processConnectedUser(userId, session);
  }

  function start() {
    if (active) return;
    active = true;
    if (!listenersInstalled) {
      mp.on('connect', connect);
      mp.on('disconnect', userId => disconnect(userId));
      listenersInstalled = true;
    }
    reconcileExistingConnections();
  }

  function stop() {
    if (!active) return;
    active = false;
    for (const [userId, session] of sessions) {
      sessions.delete(userId);
      cleanup(userId, session, 'monitor stopped');
    }
  }

  return {
    connect,
    disconnect,
    reconcileExistingConnections,
    tick,
    start,
    stop,
    sessions,
    userIdByAccount
  };
}

module.exports = {
  createConnectionMonitor,
  DEFAULT_RETRY_INTERVAL_MS
};
