const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { createConnectionMonitor } = require('./connection-monitor');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

const running = new Set();
afterEach(() => {
  for (const monitor of running) monitor.stop();
  running.clear();
});

function setup({
  checkWhitelist,
  claimLease,
  releaseLease,
  requireSessionLease = true,
  maxPlayers = 4,
  initiallyConnected = []
} = {}) {
  const users = new Map();
  const handlers = new Map();
  const cleanupCalls = [];
  const checks = [];
  const kicks = [];
  const logs = [];
  const inspectedUsers = [];
  const claims = [];
  const releases = [];
  let leaseSequence = 0;

  for (const user of initiallyConnected) {
    users.set(user.userId, {
      actorId: user.actorId,
      profileId: user.profileId,
      guid: user.guid || `guid-${user.userId}`
    });
  }

  const monitor = createConnectionMonitor({
    mp: {
      on: (event, handler) => handlers.set(event, handler),
      isConnected: userId => {
        inspectedUsers.push(userId);
        return users.has(userId);
      },
      getUserActor: userId => users.get(userId)?.actorId,
      getUserGuid: userId => users.get(userId)?.guid,
      get: (actorId, property) => {
        assert.equal(property, 'profileId');
        return [...users.values()].find(user => user.actorId === actorId)?.profileId;
      },
      getServerSettings: () => ({ maxPlayers }),
      kick: userId => kicks.push(userId)
    },
    whitelist: {
      checkWhitelist: checkWhitelist || ((userId, profileId, actorId) => {
        checks.push([userId, profileId, actorId]);
        return true;
      })
    },
    commands: { removeActiveCharacter: id => cleanupCalls.push(['character', id]) },
    playerPanel: { cleanup: id => cleanupCalls.push(['panel', id]) },
    sessionLeaseClient: {
      claim: accountId => {
        claims.push(accountId);
        return claimLease
          ? claimLease(accountId)
          : `lease-${accountId}-${++leaseSequence}`.padEnd(64, 'x');
      },
      release: leaseToken => {
        releases.push(leaseToken);
        return releaseLease ? releaseLease(leaseToken) : { ok: true, released: true };
      }
    },
    requireSessionLease,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args])
    },
    retryIntervalMs: 60_000
  });
  running.add(monitor);
  monitor.start();

  return {
    monitor, checks, cleanupCalls, kicks, logs, inspectedUsers, claims, releases,
    connect(userId, values = {}) {
      users.set(userId, {
        actorId: values.actorId,
        profileId: values.profileId,
        guid: values.guid || `guid-${userId}-${Date.now()}`
      });
      handlers.get('connect')(userId);
    },
    disconnect(userId) {
      users.delete(userId);
      handlers.get('disconnect')(userId);
    },
    update(userId, values) {
      Object.assign(users.get(userId), values);
    }
  };
}

describe('connection-monitor', () => {
  it('tenta de novo quando ator ou profile ainda nao foram publicados', async () => {
    const state = setup();
    state.connect(0);
    assert.deepEqual(state.checks, []);

    state.update(0, { actorId: 0xff000001, profileId: -1 });
    state.monitor.tick();
    assert.deepEqual(state.checks, []);
    assert.equal(state.logs.filter(entry => entry[0] === 'warn').length, 1);

    state.update(0, { profileId: 700_001 });
    state.monitor.tick();
    await flush();
    assert.deepEqual(state.checks, [[0, 700_001, 0xff000001]]);
  });

  it('invalida uma resposta antiga apos desconexao e reconexao do mesmo slot', async () => {
    const pending = [];
    const state = setup({
      checkWhitelist: (userId, profileId, actorId) => {
        const result = deferred();
        pending.push({ userId, profileId, actorId, result });
        return result.promise;
      }
    });
    state.connect(1, { actorId: 0xff000001, profileId: 7, guid: 'first' });
    await flush();
    assert.equal(pending.length, 1);

    state.disconnect(1);
    assert.deepEqual(state.cleanupCalls, [['character', 0xff000001], ['panel', 0xff000001]]);

    state.connect(1, { actorId: 0xff000002, profileId: 8, guid: 'second' });
    await flush();
    assert.equal(pending.length, 2);

    pending[0].result.resolve(false);
    await flush();
    assert.equal(state.monitor.sessions.get(1).actorId, 0xff000002);
    assert.deepEqual(state.kicks, []);

    pending[1].result.resolve(true);
    await flush();
    assert.equal(state.monitor.sessions.get(1).approved, true);
  });

  it('invalida a sessao se o GUID mudar mesmo sem evento de desconexao', async () => {
    const pending = deferred();
    const state = setup({ checkWhitelist: () => pending.promise });
    state.connect(1, { actorId: 0xff000001, profileId: 7, guid: 'first' });
    await flush();

    state.update(1, { actorId: 0xff000002, profileId: 8, guid: 'second' });
    pending.resolve(false);
    await flush();

    assert.equal(state.monitor.sessions.has(1), false);
    assert.deepEqual(state.cleanupCalls, [['character', 0xff000001], ['panel', 0xff000001]]);
    assert.deepEqual(state.kicks, []);
  });

  it('limpa uma recusa apenas uma vez e espera a desconexao real', async () => {
    const state = setup({ checkWhitelist: () => false });
    state.connect(2, { actorId: 0xff000001, profileId: 7 });
    await flush();
    assert.deepEqual(state.cleanupCalls, [['character', 0xff000001], ['panel', 0xff000001]]);

    state.monitor.tick();
    state.disconnect(2);
    assert.deepEqual(state.cleanupCalls, [['character', 0xff000001], ['panel', 0xff000001]]);
    assert.deepEqual(state.kicks, []);
  });

  it('reconcilia uma vez todos os slots configurados, inclusive userId zero', async () => {
    const state = setup({
      maxPlayers: 128,
      initiallyConnected: [
        { userId: 0, actorId: 0xff000010, profileId: 90_000 },
        { userId: 127, actorId: 0xff000011, profileId: 900_000 }
      ]
    });
    await flush();

    assert.deepEqual(state.checks, [
      [0, 90_000, 0xff000010],
      [127, 900_000, 0xff000011]
    ]);
    assert.deepEqual(
      [...new Set(state.inspectedUsers)].sort((a, b) => a - b),
      Array.from({ length: 128 }, (_, i) => i)
    );
  });

  it('aceita eventos para slots acima da capacidade inicial sem novo scan global', async () => {
    const state = setup({ maxPlayers: 1 });
    const inspectionsAfterBoot = state.inspectedUsers.length;
    state.connect(250, { actorId: 0xff000250, profileId: 123_456 });
    await flush();

    assert.deepEqual(state.checks, [[250, 123_456, 0xff000250]]);
    assert.ok(state.inspectedUsers.length > inspectionsAfterBoot);
    assert.ok(state.inspectedUsers.slice(inspectionsAfterBoot).every(userId => userId === 250));
  });

  it('reivindica o lease antes de consultar a whitelist e libera no disconnect uma vez', async () => {
    const order = [];
    const state = setup({
      claimLease: accountId => {
        order.push(`claim:${accountId}`);
        return 'lease-current'.padEnd(64, 'x');
      },
      checkWhitelist: (_userId, profileId) => {
        order.push(`whitelist:${profileId}`);
        return true;
      }
    });
    state.connect(1, { actorId: 0xff000001, profileId: 7 });
    await flush();
    assert.deepEqual(order, ['claim:7', 'whitelist:7']);

    state.disconnect(1);
    state.monitor.disconnect(1);
    await flush();
    assert.deepEqual(state.releases, ['lease-current'.padEnd(64, 'x')]);
  });

  it('claim atrasado depois do disconnect é liberado e nunca chega à whitelist', async () => {
    const pendingClaim = deferred();
    const state = setup({ claimLease: () => pendingClaim.promise });
    state.connect(1, { actorId: 0xff000001, profileId: 7 });
    state.disconnect(1);
    pendingClaim.resolve('lease-late'.padEnd(64, 'x'));
    await flush();
    await flush();
    assert.deepEqual(state.checks, []);
    assert.deepEqual(state.releases, ['lease-late'.padEnd(64, 'x')]);
  });

  it('nova conexão da mesma conta expulsa a anterior sem confundir os leases', async () => {
    const state = setup();
    state.connect(1, { actorId: 0xff000001, profileId: 7, guid: 'first' });
    await flush();
    const firstLease = state.monitor.sessions.get(1).leaseToken;

    state.connect(2, { actorId: 0xff000002, profileId: 7, guid: 'second' });
    await flush();
    const secondLease = state.monitor.sessions.get(2).leaseToken;
    await flush();

    assert.notEqual(firstLease, secondLease);
    assert.deepEqual(state.kicks, [1]);
    assert.deepEqual(state.releases, [firstLease]);
    assert.equal(state.monitor.userIdByAccount.get(7), 2);
    assert.equal(state.monitor.sessions.get(2).approved, true);
  });

  it('resposta tardia da whitelist não ressuscita conexão substituída da conta', async () => {
    const firstWhitelist = deferred();
    let checks = 0;
    const state = setup({
      checkWhitelist: () => (++checks === 1 ? firstWhitelist.promise : true)
    });
    state.connect(1, { actorId: 0xff000001, profileId: 7, guid: 'first' });
    await flush();
    state.connect(2, { actorId: 0xff000002, profileId: 7, guid: 'second' });
    await flush();
    assert.equal(state.monitor.sessions.get(1).rejected, true);

    firstWhitelist.resolve(true);
    await flush();
    assert.equal(state.monitor.sessions.get(1).approved, false);
    assert.equal(state.monitor.sessions.get(2).approved, true);
    assert.deepEqual(state.kicks, [1]);
  });

  it('falha ao reivindicar lease recusa e expulsa antes da whitelist', async () => {
    const state = setup({ claimLease: async () => { throw new Error('game-api offline'); } });
    state.connect(3, { actorId: 0xff000003, profileId: 9 });
    await flush();
    await flush();
    assert.deepEqual(state.checks, []);
    assert.deepEqual(state.kicks, [3]);
    assert.equal(state.monitor.sessions.get(3).rejected, true);
  });
});
