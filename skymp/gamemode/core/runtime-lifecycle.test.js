const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createRuntimeLifecycle } = require('./runtime-lifecycle');

function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.exits = [];
  emitter.exit = code => emitter.exits.push(code);
  return emitter;
}

describe('runtime-lifecycle — hot reload serializado', () => {
  it('repete dez reloads com exatamente uma instancia ativa', async () => {
    const lifecycle = createRuntimeLifecycle({ processApi: fakeProcess() });
    let active = 0;
    let maxActive = 0;
    const stopped = [];

    for (let id = 1; id <= 10; id++) {
      await lifecycle.replace(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        return {
          shutdown: async reason => {
            active--;
            stopped.push({ id, reason });
          }
        };
      });
      assert.equal(active, 1);
    }

    assert.equal(maxActive, 1, 'a proxima instancia nao pode subir junto da anterior');
    assert.equal(stopped.length, 9);
    assert.ok(stopped.every(item => item.reason === 'hot reload'));
    await lifecycle.shutdown('teste concluido');
    assert.equal(active, 0);
    assert.equal(stopped.length, 10);
  });

  it('espera o shutdown assincrono antes de iniciar a proxima instancia', async () => {
    const lifecycle = createRuntimeLifecycle({ processApi: fakeProcess() });
    const order = [];
    let release;

    await lifecycle.replace(async () => ({
      shutdown: () => new Promise(resolve => {
        order.push('stop:start');
        release = () => { order.push('stop:end'); resolve(); };
      })
    }));

    const replacement = lifecycle.replace(async () => {
      order.push('start:new');
      return { shutdown: async () => {} };
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stop:start']);
    release();
    await replacement;
    assert.deepEqual(order, ['stop:start', 'stop:end', 'start:new']);
  });

  it('falha de boot nao deixa instancia fantasma e permite recuperacao', async () => {
    const lifecycle = createRuntimeLifecycle({ processApi: fakeProcess() });
    await assert.rejects(lifecycle.replace(async () => { throw new Error('boot falhou'); }), /boot falhou/);
    assert.equal(lifecycle.snapshot().hasCurrent, false);
    await lifecycle.replace(async () => ({ shutdown: async () => {} }));
    assert.equal(lifecycle.snapshot().hasCurrent, true);
  });
});

describe('runtime-lifecycle — sinais do processo', () => {
  it('instala SIGINT/SIGTERM uma vez e encerra a instancia uma vez', async () => {
    const processApi = fakeProcess();
    const lifecycle = createRuntimeLifecycle({ processApi, logger: { error: () => {} } });
    assert.equal(lifecycle.installSignalHandlers(), true);
    assert.equal(lifecycle.installSignalHandlers(), false);
    assert.equal(processApi.listenerCount('SIGINT'), 1);
    assert.equal(processApi.listenerCount('SIGTERM'), 1);

    let stops = 0;
    await lifecycle.replace(async () => ({ shutdown: async () => { stops++; } }));
    processApi.emit('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1);
    assert.deepEqual(processApi.exits, [0]);
  });
});

describe('runtime-lifecycle — contrato do entrypoint', () => {
  it('phase0 registra modulos somente dentro da instancia coordenada', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'phase0-basic.js'), 'utf8');
    const prepareAt = source.indexOf('moduleRegistry.prepareForBoot()');
    const registerAt = source.indexOf('registerModules();', prepareAt);
    const bootAt = source.indexOf('await boot();', registerAt);

    assert.ok(source.includes('runtimeLifecycle.replace(startInstance)'));
    assert.ok(prepareAt >= 0 && registerAt > prepareAt && bootAt > registerAt,
      'reload precisa limpar descritores encerrados, registrar e so depois iniciar o boot');
    assert.ok(!source.includes("process.once(signal"),
      'listener de sinal no entrypoint temporario acumularia a cada reload');
    assert.ok(source.includes('unsubscribeTradeDisconnect()'),
      'assinatura de desconexao do trade precisa sair no shutdown');
  });
});
