/**
 * core/module-registry.test.js
 *
 * O registry decide o que roda no servidor e, até 13/08/2026, era o único
 * componente do `core/` sem teste nenhum — 245 linhas escolhendo módulos, e
 * nada travando o comportamento (`CORE_FRAMEWORK_AUDIT.md` §2.4).
 *
 * O caso que forçou este arquivo é o primeiro da suíte: a resolução de
 * dependência dependia da ordem de registro, então `market-stalls` só subia
 * porque `phase0-basic.js` registra `governance` antes dele.
 *
 * Executa com: node --test core/module-registry.test.js
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const moduleRegistry = require('./module-registry');
const commandRegistry = require('./command-registry');
const interactionRegistry = require('./interaction-registry');
const { STATES } = moduleRegistry;

/** Env vars criadas por um teste, para não vazarem para o seguinte. */
const flagsUsadas = new Set();

function ligar(flag) {
  process.env[flag] = 'true';
  flagsUsadas.add(flag);
}

function modulo(id, overrides = {}) {
  const flag = `TEST_ENABLE_${id.toUpperCase().replace(/-/g, '_')}`;
  return {
    id,
    enabledBy: flag,
    phase: 'lab',
    initialize: async () => {},
    ...overrides,
    // `enabledBy` do override vence, mas o padrão precisa existir antes.
    ...(overrides.enabledBy ? { enabledBy: overrides.enabledBy } : {})
  };
}

/** Silencia o log de boot, que é barulhento de propósito em produção. */
function semLog(fn) {
  const { log, warn, error } = console;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.log = log; console.warn = warn; console.error = error;
  });
}

describe('module-registry — ordenação de dependências', () => {
  beforeEach(() => { moduleRegistry._reset(); interactionRegistry._reset(); });
  afterEach(() => {
    for (const flag of flagsUsadas) delete process.env[flag];
    flagsUsadas.clear();
  });

  // O bug: `bootAll` percorria os módulos na ordem de INSERÇÃO e só considerava
  // satisfeita a dependência já inicializada numa iteração anterior. Registrar
  // o dependente primeiro o desligava com "dependências não ativas".
  it('sobe o dependente mesmo quando ele é registrado ANTES da dependência', async () => {
    const ordem = [];
    moduleRegistry.register(modulo('market-stalls', {
      dependencies: ['governance'],
      initialize: async () => { ordem.push('market-stalls'); }
    }));
    moduleRegistry.register(modulo('governance', {
      initialize: async () => { ordem.push('governance'); }
    }));
    ligar('TEST_ENABLE_MARKET_STALLS');
    ligar('TEST_ENABLE_GOVERNANCE');

    const r = await semLog(() => moduleRegistry.bootAll());

    assert.deepEqual(ordem, ['governance', 'market-stalls']);
    assert.deepEqual(r.enabled.sort(), ['governance', 'market-stalls']);
    assert.deepEqual(r.failed, []);
  });

  it('resolve cadeia de três em profundidade', async () => {
    const ordem = [];
    moduleRegistry.register(modulo('c', { dependencies: ['b'], initialize: async () => { ordem.push('c'); } }));
    moduleRegistry.register(modulo('a', { initialize: async () => { ordem.push('a'); } }));
    moduleRegistry.register(modulo('b', { dependencies: ['a'], initialize: async () => { ordem.push('b'); } }));
    ['TEST_ENABLE_A', 'TEST_ENABLE_B', 'TEST_ENABLE_C'].forEach(ligar);

    await semLog(() => moduleRegistry.bootAll());
    assert.deepEqual(ordem, ['a', 'b', 'c']);
  });

  // Ciclo é erro de quem programa. Os envolvidos ficam de fora, nomeados — o
  // servidor não trava e a ordem não vira sorte.
  it('detecta ciclo e mantém os módulos sãos', async () => {
    moduleRegistry.register(modulo('x', { dependencies: ['y'] }));
    moduleRegistry.register(modulo('y', { dependencies: ['x'] }));
    moduleRegistry.register(modulo('livre'));
    ['TEST_ENABLE_X', 'TEST_ENABLE_Y', 'TEST_ENABLE_LIVRE'].forEach(ligar);

    const { cycles, ordered } = moduleRegistry.topologicalOrder();
    assert.equal(cycles.length > 0, true);
    assert.ok(cycles.some(c => c.includes('x') && c.includes('y')));
    assert.ok(ordered.includes('livre'));

    const r = await semLog(() => moduleRegistry.bootAll());
    assert.deepEqual(r.enabled, ['livre']);
  });

  it('dependência desligada por flag reprova o dependente, sem derrubar o resto', async () => {
    moduleRegistry.register(modulo('governance'));
    moduleRegistry.register(modulo('market-stalls', { dependencies: ['governance'] }));
    moduleRegistry.register(modulo('voip'));
    ligar('TEST_ENABLE_MARKET_STALLS');
    ligar('TEST_ENABLE_VOIP');
    // TEST_ENABLE_GOVERNANCE fica desligada de propósito

    const r = await semLog(() => moduleRegistry.bootAll());

    assert.deepEqual(r.enabled, ['voip']);
    assert.deepEqual(r.disabled, ['governance']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].id, 'market-stalls');
    assert.match(r.failed[0].reason, /governance/);
  });

  it('dependência que FALHA reprova o dependente', async () => {
    moduleRegistry.register(modulo('governance', {
      initialize: async () => { throw new Error('banco fora'); }
    }));
    moduleRegistry.register(modulo('market-stalls', { dependencies: ['governance'] }));
    ligar('TEST_ENABLE_GOVERNANCE');
    ligar('TEST_ENABLE_MARKET_STALLS');

    const r = await semLog(() => moduleRegistry.bootAll());
    assert.deepEqual(r.enabled, []);
    assert.deepEqual(r.failed.map(f => f.id).sort(), ['governance', 'market-stalls']);
  });

  it('dependência opcional não impede o boot, e entra na ordenação quando existe', async () => {
    const ordem = [];
    moduleRegistry.register(modulo('governance', {
      optionalDependencies: ['economy-regional'],
      initialize: async () => { ordem.push('governance'); }
    }));
    moduleRegistry.register(modulo('economy-regional', {
      initialize: async () => { ordem.push('economy-regional'); }
    }));

    // Só a governança ligada: a opcional some e nada falha.
    ligar('TEST_ENABLE_GOVERNANCE');
    let r = await semLog(() => moduleRegistry.bootAll());
    assert.deepEqual(r.enabled, ['governance']);
    assert.deepEqual(r.failed, []);
    assert.equal(moduleRegistry.isEnabled('economy-regional'), false);

    // Com as duas ligadas, a opcional sobe ANTES de quem a consulta.
    moduleRegistry._reset();
    ordem.length = 0;
    moduleRegistry.register(modulo('governance', {
      optionalDependencies: ['economy-regional'],
      initialize: async () => { ordem.push('governance'); }
    }));
    moduleRegistry.register(modulo('economy-regional', {
      initialize: async () => { ordem.push('economy-regional'); }
    }));
    ligar('TEST_ENABLE_ECONOMY_REGIONAL');
    r = await semLog(() => moduleRegistry.bootAll());
    assert.deepEqual(ordem, ['economy-regional', 'governance']);
  });

  it('dependência para módulo nunca registrado reprova com o nome dela', async () => {
    moduleRegistry.register(modulo('orfao', { dependencies: ['modulo-fantasma'] }));
    ligar('TEST_ENABLE_ORFAO');

    const r = await semLog(() => moduleRegistry.bootAll());
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].reason, /modulo-fantasma/);
  });
});

describe('module-registry — ciclo de vida', () => {
  beforeEach(() => { moduleRegistry._reset(); interactionRegistry._reset(); });
  afterEach(() => {
    for (const flag of flagsUsadas) delete process.env[flag];
    flagsUsadas.clear();
  });

  // A distinção que o `Set` não fazia: desligado por flag e falhou ao
  // inicializar respondem os dois `false` a `isEnabled`, e só um é incidente.
  it('distingue DISABLED de FAILED, que isEnabled confunde', async () => {
    moduleRegistry.register(modulo('quieto'));
    moduleRegistry.register(modulo('quebrado', { initialize: async () => { throw new Error('boom'); } }));
    ligar('TEST_ENABLE_QUEBRADO');

    await semLog(() => moduleRegistry.bootAll());

    assert.equal(moduleRegistry.isEnabled('quieto'), false);
    assert.equal(moduleRegistry.isEnabled('quebrado'), false);
    assert.equal(moduleRegistry.getState('quieto'), STATES.DISABLED);
    assert.equal(moduleRegistry.getState('quebrado'), STATES.FAILED);
  });

  it('percorre REGISTERED → RUNNING → STOPPED', async () => {
    moduleRegistry.register(modulo('vivo'));
    assert.equal(moduleRegistry.getState('vivo'), STATES.REGISTERED);

    ligar('TEST_ENABLE_VIVO');
    await semLog(() => moduleRegistry.bootAll());
    assert.equal(moduleRegistry.getState('vivo'), STATES.RUNNING);
    assert.equal(moduleRegistry.isEnabled('vivo'), true);

    await semLog(() => moduleRegistry.shutdownAll());
    assert.equal(moduleRegistry.getState('vivo'), STATES.STOPPED);
    assert.equal(moduleRegistry.isEnabled('vivo'), false);
  });

  it('getState devolve null para módulo nunca registrado', () => {
    assert.equal(moduleRegistry.getState('nao-existe'), null);
  });

  it('readiness falha quando core habilitado não inicializa', async () => {
    moduleRegistry.register(modulo('fronteira', {
      phase: 'core',
      initialize: async () => { throw new Error('sem dependencia'); }
    }));
    ligar('TEST_ENABLE_FRONTEIRA');
    await semLog(() => moduleRegistry.bootAll());

    assert.throws(() => moduleRegistry.assertCoreReady(), /fronteira.*FAILED/);
  });

  it('readiness falha quando health check de core reprova', async () => {
    moduleRegistry.register(modulo('fronteira', {
      phase: 'core',
      healthCheck: () => false
    }));
    ligar('TEST_ENABLE_FRONTEIRA');
    await semLog(() => moduleRegistry.bootAll());

    assert.throws(() => moduleRegistry.assertCoreReady(), /fronteira.*healthCheck=false/);
  });

  it('readiness ignora lab com falha e core desligado por configuração', async () => {
    moduleRegistry.register(modulo('core-opcional', { phase: 'core' }));
    moduleRegistry.register(modulo('laboratorio', {
      phase: 'lab',
      initialize: async () => { throw new Error('spike quebrou'); }
    }));
    ligar('TEST_ENABLE_LABORATORIO');
    await semLog(() => moduleRegistry.bootAll());

    assert.equal(moduleRegistry.assertCoreReady(), true);
  });

  it('desliga na ordem inversa do boot', async () => {
    const ordem = [];
    moduleRegistry.register(modulo('base', { shutdown: async () => { ordem.push('base'); } }));
    moduleRegistry.register(modulo('cima', {
      dependencies: ['base'],
      shutdown: async () => { ordem.push('cima'); }
    }));
    ligar('TEST_ENABLE_BASE');
    ligar('TEST_ENABLE_CIMA');

    await semLog(() => moduleRegistry.bootAll());
    await semLog(() => moduleRegistry.shutdownAll());

    assert.deepEqual(ordem, ['cima', 'base'], 'quem depende desliga antes de quem é dependido');
  });

  it('limpa initialize parcial chamando shutdown mesmo sem chegar a RUNNING', async () => {
    let resourceOpen = false;
    moduleRegistry.register(modulo('parcial', {
      initialize: async () => {
        resourceOpen = true;
        throw new Error('falhou depois de abrir recurso');
      },
      shutdown: async () => { resourceOpen = false; }
    }));
    ligar('TEST_ENABLE_PARCIAL');

    const result = await semLog(() => moduleRegistry.bootAll());
    assert.equal(result.failed[0].id, 'parcial');
    assert.equal(resourceOpen, false, 'timer/socket aberto antes da falha precisa ser fechado');
  });

  it('prepareForBoot recusa modulo ativo e limpa descritores depois do shutdown', async () => {
    moduleRegistry.register(modulo('reloadavel'));
    ligar('TEST_ENABLE_RELOADAVEL');
    await semLog(() => moduleRegistry.bootAll());

    assert.throws(() => moduleRegistry.prepareForBoot(), /ainda ativo/);
    await semLog(() => moduleRegistry.shutdownAll());
    moduleRegistry.prepareForBoot();
    assert.deepEqual(moduleRegistry.list(), []);

    assert.doesNotThrow(() => moduleRegistry.register(modulo('reloadavel')),
      'o proximo entrypoint deve registrar os mesmos ids sem colisao de cache');
  });

  it('recusa o mesmo id registrado duas vezes', () => {
    moduleRegistry.register(modulo('unico'));
    assert.throws(() => moduleRegistry.register(modulo('unico')), /registrado duas vezes/);
  });

  it('recusa descritor sem id, sem enabledBy ou sem initialize', () => {
    assert.throws(() => moduleRegistry.register({ enabledBy: 'X', initialize: async () => {} }), /sem id/);
    assert.throws(() => moduleRegistry.register({ id: 'a', initialize: async () => {} }), /sem enabledBy/);
    assert.throws(() => moduleRegistry.register({ id: 'a', enabledBy: 'X' }), /sem função initialize/);
  });

  it('list expõe estado, versão e dependências', async () => {
    moduleRegistry.register(modulo('com-versao', { version: '2.1.0', dependencies: [], optionalDependencies: ['x'] }));
    ligar('TEST_ENABLE_COM_VERSAO');
    await semLog(() => moduleRegistry.bootAll());

    const entrada = moduleRegistry.list().find(m => m.id === 'com-versao');
    assert.equal(entrada.version, '2.1.0');
    assert.equal(entrada.state, STATES.RUNNING);
    assert.deepEqual(entrada.optionalDependencies, ['x']);
  });

  it('healthCheckAll só olha o que está ativo e isola exceção', async () => {
    moduleRegistry.register(modulo('sao', { healthCheck: () => true }));
    moduleRegistry.register(modulo('doente', { healthCheck: () => false }));
    moduleRegistry.register(modulo('explosivo', { healthCheck: () => { throw new Error('sem banco'); } }));
    moduleRegistry.register(modulo('desligado'));
    ['TEST_ENABLE_SAO', 'TEST_ENABLE_DOENTE', 'TEST_ENABLE_EXPLOSIVO'].forEach(ligar);

    await semLog(() => moduleRegistry.bootAll());
    const report = moduleRegistry.healthCheckAll();

    assert.deepEqual(report.map(r => r.id).sort(), ['doente', 'explosivo', 'sao']);
    assert.equal(report.find(r => r.id === 'explosivo').healthy, false);
    assert.equal(report.find(r => r.id === 'explosivo').error, 'sem banco');
  });
});

describe('module-registry — limpeza de comandos e interações', () => {
  beforeEach(() => { moduleRegistry._reset(); interactionRegistry._reset(); });
  afterEach(async () => {
    await semLog(() => moduleRegistry.shutdownAll());
    for (const flag of flagsUsadas) delete process.env[flag];
    flagsUsadas.clear();
  });

  it('registra comandos no boot e os remove no shutdown', async () => {
    moduleRegistry.register(modulo('comandado', {
      commands: [{ name: '/testecmd', handler: () => {}, description: 'teste' }]
    }));
    ligar('TEST_ENABLE_COMANDADO');

    await semLog(() => moduleRegistry.bootAll());
    assert.equal(commandRegistry.has('/testecmd'), true);

    await semLog(() => moduleRegistry.shutdownAll());
    assert.equal(commandRegistry.has('/testecmd'), false);
  });

  // Uma ação que sobrevive ao desligamento aparece no menu e executa contra um
  // serviço que não está mais lá. Automático pelo mesmo motivo que os comandos.
  it('remove as interações do módulo no shutdown', async () => {
    moduleRegistry.register(modulo('interativo', {
      initialize: async () => {
        interactionRegistry.register({
          id: 'interativo.acao', module: 'interativo',
          target: 'player', label: 'Ação', execute: async () => {}
        });
      }
    }));
    ligar('TEST_ENABLE_INTERATIVO');

    await semLog(() => moduleRegistry.bootAll());
    assert.ok(interactionRegistry.get('interativo.acao'));

    await semLog(() => moduleRegistry.shutdownAll());
    assert.equal(interactionRegistry.get('interativo.acao'), undefined);
  });

  // Um módulo que registra a interação e DEPOIS explode deixaria a ação órfã.
  it('remove as interações de um módulo que falha no meio do initialize', async () => {
    moduleRegistry.register(modulo('meio-caminho', {
      initialize: async () => {
        interactionRegistry.register({
          id: 'meio.acao', module: 'meio-caminho',
          target: 'player', label: 'Ação', execute: async () => {}
        });
        throw new Error('banco fora depois de registrar');
      }
    }));
    ligar('TEST_ENABLE_MEIO_CAMINHO');

    const r = await semLog(() => moduleRegistry.bootAll());

    assert.equal(r.failed[0].id, 'meio-caminho');
    assert.equal(interactionRegistry.get('meio.acao'), undefined,
      'a ação ficaria no menu apontando para um serviço que nunca inicializou');
  });

  it('erro no shutdown não impede o desligamento dos demais', async () => {
    const desligados = [];
    moduleRegistry.register(modulo('a', { shutdown: async () => { desligados.push('a'); } }));
    moduleRegistry.register(modulo('b', { shutdown: async () => { throw new Error('travou'); } }));
    moduleRegistry.register(modulo('c', { shutdown: async () => { desligados.push('c'); } }));
    ['TEST_ENABLE_A', 'TEST_ENABLE_B', 'TEST_ENABLE_C'].forEach(ligar);

    await semLog(() => moduleRegistry.bootAll());
    await semLog(() => moduleRegistry.shutdownAll());

    assert.deepEqual(desligados.sort(), ['a', 'c']);
    assert.equal(moduleRegistry.isEnabled('b'), false, 'o que falhou ao desligar não pode continuar "ativo"');
  });
});
