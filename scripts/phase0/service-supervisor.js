'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_POLICY = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  restartWindowMs: 60_000,
  maxRestartsInWindow: 5,
  stableAfterMs: 120_000,
  probeIntervalMs: 5_000,
  probeFailureThreshold: 3,
  shutdownTimeoutMs: 10_000,
});

function calculateBackoff(restartNumber, policy = {}, random = Math.random) {
  const options = { ...DEFAULT_POLICY, ...policy };
  const exponent = Math.max(0, Number(restartNumber) - 1);
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** exponent));
  const jitter = raw * options.jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(raw + jitter));
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class ServiceSupervisor extends EventEmitter {
  constructor(services, dependencies = {}, policy = {}) {
    super();
    if (!Array.isArray(services) || services.length === 0) {
      throw new TypeError('services must be a non-empty array');
    }
    this.services = services;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.spawn = dependencies.spawn;
    this.preflight = dependencies.preflight || (async () => {});
    this.probe = dependencies.probe || (async () => ({ alive: true, ready: true }));
    this.now = dependencies.now || Date.now;
    this.random = dependencies.random || Math.random;
    this.setTimer = dependencies.setTimeout || setTimeout;
    this.clearTimer = dependencies.clearTimeout || clearTimeout;
    this.log = dependencies.log || (() => {});
    if (typeof this.spawn !== 'function') throw new TypeError('spawn dependency is required');

    this.states = new Map(services.map(service => [service.name, {
      service,
      child: null,
      startedAt: 0,
      restarts: [],
      restartTimer: null,
      probeTimer: null,
      probeFailures: 0,
      ready: false,
    }]));
    this.stopping = false;
    this.started = false;
    this.exitCode = null;
    this.doneDeferred = createDeferred();
  }

  async start() {
    if (this.started) throw new Error('supervisor already started');
    this.started = true;
    for (const service of this.services) await this.preflight(service);
    for (const service of this.services) this.launch(service.name);
    return this;
  }

  launch(name) {
    if (this.stopping) return;
    const state = this.states.get(name);
    if (!state || state.child) return;
    const child = this.spawn(state.service);
    state.child = child;
    state.startedAt = this.now();
    state.probeFailures = 0;
    state.ready = false;
    this.log('info', name, `processo iniciado (PID ${child.pid ?? 'desconhecido'})`);
    this.emit('started', { name, pid: child.pid });

    child.once('exit', (code, signal) => this.handleExit(name, child, code, signal));
    child.once('error', error => this.handleChildError(name, child, error));
    this.scheduleProbe(name, 0);
  }

  handleChildError(name, child, error) {
    const state = this.states.get(name);
    if (!state || state.child !== child || this.stopping) return;
    this.log('error', name, `erro do processo: ${error.message}`);
  }

  handleExit(name, child, code, signal) {
    const state = this.states.get(name);
    if (!state || state.child !== child) return;
    state.child = null;
    state.ready = false;
    if (state.probeTimer) this.clearTimer(state.probeTimer);
    state.probeTimer = null;
    this.emit('exited', { name, code, signal });
    if (this.stopping) return;

    const now = this.now();
    if (now - state.startedAt >= this.policy.stableAfterMs) state.restarts = [];
    state.restarts = state.restarts.filter(timestamp => now - timestamp <= this.policy.restartWindowMs);
    state.restarts.push(now);
    if (state.restarts.length > this.policy.maxRestartsInWindow) {
      this.fail(`crash loop em ${name}: ${state.restarts.length} encerramentos em ${this.policy.restartWindowMs}ms`);
      return;
    }

    const delay = calculateBackoff(state.restarts.length, this.policy, this.random);
    this.log('warn', name, `encerrou (code=${code}, signal=${signal || 'none'}); reinicio em ${delay}ms`);
    state.restartTimer = this.setTimer(() => {
      state.restartTimer = null;
      this.launch(name);
    }, delay);
  }

  scheduleProbe(name, delay = this.policy.probeIntervalMs) {
    const state = this.states.get(name);
    if (!state || this.stopping || !state.child) return;
    if (state.probeTimer) this.clearTimer(state.probeTimer);
    state.probeTimer = this.setTimer(() => {
      state.probeTimer = null;
      this.runProbe(name).catch(error => {
        this.log('error', name, `probe falhou: ${error.message}`);
      });
    }, delay);
  }

  async runProbe(name) {
    const state = this.states.get(name);
    if (!state || this.stopping || !state.child) return;
    let result;
    try {
      result = await this.probe(state.service, state.child, this.now() - state.startedAt);
    } catch (error) {
      result = { alive: false, ready: false, detail: error.message };
    }
    if (!state.child || this.stopping) return;

    const wasReady = state.ready;
    state.ready = result.ready === true;
    if (state.ready !== wasReady) {
      this.log(
        state.ready ? 'info' : 'warn',
        name,
        state.ready ? 'readiness aprovada' : `readiness reprovada: ${result.detail || 'sem detalhe'}`,
      );
    }
    if (result.alive === true) {
      state.probeFailures = 0;
    } else {
      state.probeFailures += 1;
      this.log('warn', name, `liveness reprovada ${state.probeFailures}/${this.policy.probeFailureThreshold}: ${result.detail || 'sem detalhe'}`);
      if (state.probeFailures >= this.policy.probeFailureThreshold) {
        this.log('error', name, 'limite de liveness atingido; solicitando reinicio');
        state.child.kill('SIGTERM');
        return;
      }
    }
    this.emit('probe', { name, ...result });
    this.scheduleProbe(name);
  }

  snapshot() {
    return [...this.states.values()].map(state => ({
      name: state.service.name,
      running: Boolean(state.child),
      ready: state.ready,
      restartsInWindow: state.restarts.length,
      probeFailures: state.probeFailures,
    }));
  }

  async waitForReady(timeoutMs = 60_000) {
    const startedAt = this.now();
    while (!this.stopping && this.now() - startedAt < timeoutMs) {
      if ([...this.states.values()].every(state => state.child && state.ready)) return true;
      await new Promise(resolve => this.setTimer(resolve, 50));
    }
    return false;
  }

  async fail(message) {
    if (this.stopping) return;
    this.log('error', 'supervisor', message);
    this.emit('fatal', { message });
    await this.stop(1);
  }

  async stop(exitCode = 0, options = {}) {
    if (this.stopping) return this.doneDeferred.promise;
    this.stopping = true;
    this.exitCode = exitCode;
    const waits = [];
    for (const state of this.states.values()) {
      if (state.restartTimer) this.clearTimer(state.restartTimer);
      if (state.probeTimer) this.clearTimer(state.probeTimer);
      state.restartTimer = null;
      state.probeTimer = null;
      if (!state.child) continue;
      const child = state.child;
      waits.push(new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.clearTimer(forceTimer);
          resolve();
        };
        child.once('exit', finish);
        const forceTimer = this.setTimer(() => {
          if (settled) return;
          this.log('warn', state.service.name, 'shutdown gracioso expirou; forcando processo');
          child.kill('SIGKILL');
          finish();
        }, this.policy.shutdownTimeoutMs);
        if (options.initialSignal !== null) child.kill(options.initialSignal || 'SIGTERM');
      }));
    }
    await Promise.all(waits);
    this.doneDeferred.resolve(exitCode);
    this.emit('stopped', { exitCode });
    return exitCode;
  }

  wait() {
    return this.doneDeferred.promise;
  }
}

module.exports = {
  DEFAULT_POLICY,
  ServiceSupervisor,
  calculateBackoff,
};
