'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { ServiceSupervisor, calculateBackoff } = require('./service-supervisor');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === 'SIGTERM' || signal === 'SIGKILL') this.emit('exit', null, signal);
    return true;
  }
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    runNext(delay) {
      const timer = timers.find(item => !item.cleared && (delay == null || item.delay === delay));
      assert.ok(timer, `timer ${delay ?? 'any'} not found`);
      timer.cleared = true;
      timer.callback();
      return timer;
    },
  };
}

describe('politica de restart', () => {
  test('backoff cresce exponencialmente, respeita teto e jitter controlado', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 450, jitterRatio: 0 };
    assert.equal(calculateBackoff(1, policy), 100);
    assert.equal(calculateBackoff(2, policy), 200);
    assert.equal(calculateBackoff(3, policy), 400);
    assert.equal(calculateBackoff(4, policy), 450);
    assert.equal(calculateBackoff(1, { ...policy, jitterRatio: 0.2 }, () => 1), 120);
  });

  test('todas as prechecagens terminam antes do primeiro spawn', async () => {
    const order = [];
    const supervisor = new ServiceSupervisor(
      [{ name: 'web' }, { name: 'api' }],
      {
        preflight: async service => order.push(`check:${service.name}`),
        spawn: service => {
          order.push(`spawn:${service.name}`);
          return new FakeChild(service.name);
        },
        setTimeout: () => ({ fake: true }),
        clearTimeout: () => {},
      },
    );
    await supervisor.start();
    assert.deepEqual(order, ['check:web', 'check:api', 'spawn:web', 'spawn:api']);
    await supervisor.stop();
  });

  test('processo encerrado reinicia com backoff sem duplicar instancia', async () => {
    const timers = fakeTimers();
    const children = [];
    let now = 1_000;
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }],
      {
        spawn: () => {
          const child = new FakeChild(children.length + 1);
          children.push(child);
          return child;
        },
        now: () => now,
        random: () => 0.5,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
      { baseDelayMs: 100, jitterRatio: 0 },
    );
    await supervisor.start();
    children[0].emit('exit', 1, null);
    assert.equal(supervisor.snapshot()[0].running, false);
    timers.runNext(100);
    assert.equal(children.length, 2);
    assert.equal(supervisor.snapshot()[0].running, true);
    await supervisor.stop();
  });

  test('crash loop abre circuito e encerra os demais servicos', async () => {
    const timers = fakeTimers();
    const children = [];
    let now = 1_000;
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }, { name: 'web' }],
      {
        spawn: service => {
          const child = new FakeChild(`${service.name}-${children.length}`);
          children.push(child);
          return child;
        },
        now: () => now,
        random: () => 0.5,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
      { baseDelayMs: 1, jitterRatio: 0, maxRestartsInWindow: 1 },
    );
    await supervisor.start();
    children[0].emit('exit', 1, null);
    timers.runNext(1);
    now += 1;
    const stopped = once(supervisor, 'stopped');
    children[2].emit('exit', 1, null);
    const [result] = await stopped;
    assert.equal(result.exitCode, 1);
    assert.deepEqual(children[1].kills, ['SIGTERM']);
  });
});

describe('health e shutdown', () => {
  test('tres falhas consecutivas de liveness solicitam restart', async () => {
    const timers = fakeTimers();
    const child = new FakeChild(10);
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }],
      {
        spawn: () => child,
        probe: async () => ({ alive: false, ready: false, detail: 'HTTP timeout' }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
      { probeFailureThreshold: 3, probeIntervalMs: 10 },
    );
    await supervisor.start();
    for (let index = 0; index < 3; index += 1) {
      timers.runNext(index === 0 ? 0 : 10);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(child.kills, ['SIGTERM']);
  });

  test('readiness reprovada nao mata processo que continua vivo', async () => {
    const timers = fakeTimers();
    const child = new FakeChild(11);
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }],
      {
        spawn: () => child,
        probe: async () => ({ alive: true, ready: false, detail: 'MariaDB indisponivel' }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    );
    await supervisor.start();
    timers.runNext(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(supervisor.snapshot()[0].ready, false);
    assert.deepEqual(child.kills, []);
    await supervisor.stop();
  });

  test('shutdown envia SIGTERM uma vez e nao agenda restart', async () => {
    const timers = fakeTimers();
    const child = new FakeChild(12);
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }],
      {
        spawn: () => child,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    );
    await supervisor.start();
    const exitCode = await supervisor.stop(0);
    assert.equal(exitCode, 0);
    assert.deepEqual(child.kills, ['SIGTERM']);
    assert.equal(supervisor.snapshot()[0].running, false);
    assert.equal(timers.timers.filter(timer => !timer.cleared).length, 0);
  });

  test('shutdown por Ctrl+C do grupo pode aguardar cleanup antes de forcar', async () => {
    const timers = fakeTimers();
    const child = new FakeChild(13);
    const supervisor = new ServiceSupervisor(
      [{ name: 'api' }],
      {
        spawn: () => child,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
      { shutdownTimeoutMs: 25 },
    );
    await supervisor.start();
    const stopping = supervisor.stop(0, { initialSignal: null });
    assert.deepEqual(child.kills, []);
    timers.runNext(25);
    await stopping;
    assert.deepEqual(child.kills, ['SIGKILL']);
  });
});
