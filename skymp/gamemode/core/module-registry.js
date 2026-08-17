/**
 * core/module-registry.js
 *
 * Registro central do ciclo de vida de módulos.
 *
 * Cada módulo declara:
 *   - id: identificador único
 *   - enabledBy: variável de ambiente que ativa o módulo (process.env[enabledBy] === 'true')
 *   - phase: 'core' | 'lab' | 'parked' (informativo, ajuda no diagnóstico)
 *   - dependencies: IDs de outros módulos que devem estar ativos
 *   - commands: lista de comandos registrados (para cleanup automático)
 *   - actions: lista de ações registradas na action-policy
 *   - initialize(path): função de inicialização
 *   - shutdown(): função de desligamento (opcional)
 *   - healthCheck(): função de verificação de saúde (opcional, retorna boolean)
 *
 * Fluxo:
 *   1. Módulos chamam moduleRegistry.register(descriptor) ao carregar
 *   2. phase0-basic.js chama moduleRegistry.bootAll() no startup
 *   3. bootAll() verifica env var, resolve dependências e chama initialize()
 *   4. Comandos são registrados no commandRegistry automaticamente se o módulo estiver ativo
 *   5. Na desconexão/shutdown, shutdown() é chamado e comandos são removidos
 *
 * ─── Distribuição de eventos de jogo: ADIADA, e por quê ─────────────────────
 *
 * O sistema de módulos do Red House distribui eventos de jogo (`onHit`,
 * `onCellChange`) para qualquer módulo que queira escutar — não só para quem o
 * evento foi originalmente escrito. Este registry só tem ciclo de vida
 * (`initialize`/`shutdown`/`healthCheck`), e o estudo registrou aquilo como
 * "um dia pode valer"
 * (`docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1, "Outras coisas
 * que aprendemos").
 *
 * **Avaliado em 06/08/2026 e deliberadamente não feito.** O censo dos seis
 * módulos registrados hoje (`phase0-basic.js`):
 *
 *   | módulo        | evento de jogo que escutaria |
 *   |---------------|------------------------------|
 *   | death         | hit — e só ele                |
 *   | governance    | nenhum                        |
 *   | market-stalls | nenhum                        |
 *   | player-panel  | nenhum (faz polling de Papyrus e assina o panel-refresh-bus, que é interno, não evento de jogo) |
 *   | voip          | nenhum                        |
 *   | npc-cleaner   | nenhum                        |
 *
 * **Um consumidor, um tipo de evento.** `core/hit-events.js` entrega o episódio
 * direto ao assinante que o `death-service` passa em `hitEvents.start(cb)` —
 * uma linha, sem indireção. Um despacho genérico aqui trocaria essa linha por
 * um barramento que serve a um só, e o `descriptor.on = { hit, cellChange }`
 * teria uma chave viva e uma morta desde o primeiro dia.
 *
 * `onCellChange` **não tem consumidor nenhum**, nem sequer um: `safe-zones.js`
 * consulta `mp.get(actorId, 'locationalData')` sob demanda — é leitura de
 * property, servida do cache do servidor, sem o custo de ida ao Papyrus —, e o
 * sistema de território que motivaria o evento está em "Pós-Alfa" no
 * `HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md`. Construir a distribuição por causa
 * dele seria construir infraestrutura para uma feature que ainda não passou
 * pelas 15 perguntas da Constituição §15.
 *
 * O precedente do próprio projeto diz o mesmo: quando um segundo consumidor
 * apareceu de verdade — governança precisando avisar o painel —, a resposta foi
 * `core/panel-refresh-bus.js`, um barramento pequeno e nomeado, não um canal
 * genérico no registry. Serve de modelo se um terceiro caso aparecer.
 *
 * **O gatilho para reabrir isto**, para quem chegar aqui depois: um segundo
 * módulo que precise de um evento de jogo já capturado por outro. Aí o desenho
 * é `descriptor.on = { hit: fn, cellChange: fn }` opcional no `register()`,
 * despachado a partir de onde o evento já é capturado hoje
 * (`core/hit-events.js`), com teste no padrão do resto deste arquivo. Até lá,
 * generalizar seria abstração prematura — a mesma que a §15 pede para evitar na
 * camada de mecânica de mundo, pelo mesmo motivo.
 */

const commandRegistry = require('./command-registry');
const interactionRegistry = require('./interaction-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de vida (13/08/2026)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estados possíveis de um módulo.
 *
 * ─── Por que isto deixou de ser um `Set` ────────────────────────────────────
 *
 * Até aqui o estado era "está em `_active` ou não". Dois estados, para cinco
 * situações distintas — e duas delas se confundiam de um jeito que importa:
 * um módulo **desligado por env flag** e um módulo que **falhou ao
 * inicializar** respondiam a mesma coisa a `isEnabled()`, que é `false`.
 *
 * A diferença é operacional. O primeiro é o estado normal de todo módulo `lab`
 * deste servidor; o segundo é um incidente. Um servidor com `governance`
 * quebrado no boot parecia, para qualquer código e para o `list()`, um servidor
 * que simplesmente não quis governança.
 *
 * `FAILED` também é o estado que o Interaction Framework precisa distinguir: um
 * módulo que registrou interações e depois falhou deixaria ações no menu
 * apontando para um serviço que nunca inicializou. É por isso que `bootAll`
 * limpa o registro de interações de quem falha.
 */
const STATES = Object.freeze({
  REGISTERED: 'REGISTERED',
  DISABLED: 'DISABLED',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  FAILED: 'FAILED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED'
});

// ─────────────────────────────────────────────────────────────────────────────
// Registro interno
// ─────────────────────────────────────────────────────────────────────────────

// Mapa de id → descriptor completo
const _modules = new Map();

// Módulos que foram inicializados com sucesso
const _active = new Set();

// Mapa de id → um de STATES
const _states = new Map();

/**
 * Ordena os módulos de forma que toda dependência venha antes de quem depende
 * dela, independentemente da ordem em que foram registrados.
 *
 * ─── O bug que isto conserta ────────────────────────────────────────────────
 *
 * `bootAll` percorria `_modules` na ordem de inserção e checava
 * `dependencies.filter(dep => !_active.has(dep))` — ou seja, uma dependência só
 * contava como satisfeita se **já tivesse sido inicializada numa iteração
 * anterior**. Funcionava porque `phase0-basic.js` registra `governance` antes de
 * `market-stalls`. Mover aquele bloco vinte linhas para cima desligava o módulo
 * com "dependências não ativas: governance" — uma mensagem correta sobre um
 * estado que não deveria existir.
 *
 * Ciclo é erro de quem programa, não condição de runtime: os módulos envolvidos
 * são nomeados e ficam de fora do boot, em vez de o servidor travar ou de a
 * ordem virar sorte.
 *
 * @returns {{ordered: string[], cycles: string[]}}
 */
function topologicalOrder() {
  const ordered = [];
  const cycles = [];
  const visitState = new Map(); // id → 'visiting' | 'done'

  function visit(id, path) {
    const state = visitState.get(id);
    if (state === 'done') return true;
    if (state === 'visiting') {
      cycles.push([...path.slice(path.indexOf(id)), id].join(' → '));
      return false;
    }
    const mod = _modules.get(id);
    if (!mod) return true; // dependência para módulo não registrado: tratada no boot

    visitState.set(id, 'visiting');
    path.push(id);
    let ok = true;
    // Obrigatórias e opcionais entram na ordenação: a opcional não é exigida
    // para ligar, mas se estiver ligada precisa estar pronta antes.
    for (const dep of [...mod.dependencies, ...mod.optionalDependencies]) {
      if (!visit(dep, path)) ok = false;
    }
    path.pop();
    visitState.set(id, 'done');
    if (ok) ordered.push(id);
    return ok;
  }

  for (const id of _modules.keys()) visit(id, []);
  return { ordered, cycles };
}

// ─────────────────────────────────────────────────────────────────────────────
// API Pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra um módulo no registry.
 * Deve ser chamado no carregamento do arquivo do módulo, antes do bootAll().
 *
 * @param {object} descriptor
 * @param {string}   descriptor.id           - ID único do módulo (ex: 'woodcutting')
 * @param {string}   descriptor.enabledBy    - Nome da env var que ativa este módulo
 * @param {string}   [descriptor.phase]      - 'core' | 'lab' | 'parked' (padrão: 'parked')
 * @param {string}   [descriptor.version]    - versão do módulo (informativa, aparece no diagnóstico)
 * @param {string[]} [descriptor.dependencies] - IDs de módulos obrigatórios
 * @param {string[]} [descriptor.optionalDependencies] - IDs consultados só se estiverem ativos
 * @param {object[]} [descriptor.commands]   - [{ name, handler, opts }]
 * @param {Function} descriptor.initialize   - async () => void
 * @param {Function} [descriptor.shutdown]   - async () => void
 * @param {Function} [descriptor.healthCheck] - () => boolean
 */
function register(descriptor) {
  const {
    id,
    enabledBy,
    phase = 'parked',
    version = '0.0.0',
    dependencies = [],
    // Declarar o que é opcional tira a decisão de dentro de uma função de
    // domínio. O caso real é o `governance`, que consulta `economy-regional` se
    // ele estiver ligado e resolvia isso com `isEnabled()` + `require` dentro de
    // um `try`, no meio de `getInteractionActions`.
    optionalDependencies = [],
    commands = [],
    initialize,
    shutdown = async () => {},
    healthCheck = () => true
  } = descriptor;

  if (!id) throw new Error('[module-registry] Módulo sem id');
  if (!enabledBy) throw new Error(`[module-registry] Módulo '${id}' sem enabledBy`);
  if (typeof initialize !== 'function') throw new Error(`[module-registry] Módulo '${id}' sem função initialize`);
  if (_modules.has(id)) throw new Error(`[module-registry] Módulo '${id}' registrado duas vezes`);

  _modules.set(id, {
    id, enabledBy, phase, version,
    dependencies, optionalDependencies,
    commands, initialize, shutdown, healthCheck
  });
  _states.set(id, STATES.REGISTERED);
}

/**
 * Verifica se um módulo está ativo (foi inicializado com sucesso).
 * @param {string} id
 * @returns {boolean}
 */
function isEnabled(id) {
  return _active.has(id);
}

/**
 * Estado atual de um módulo, ou `null` se ele nem foi registrado.
 *
 * Diferente de `isEnabled`, isto distingue **desligado por flag** de **falhou
 * ao inicializar** — os dois respondem `false` ali, e só um é incidente.
 *
 * @param {string} id
 * @returns {string|null}
 */
function getState(id) {
  return _states.get(id) || null;
}

/**
 * Inicializa todos os módulos registrados cujas env vars estejam ativas.
 * Resolve dependências e registra comandos automaticamente.
 *
 * Deve ser chamado UMA VEZ no boot (phase0-basic.js).
 */
async function bootAll() {
  console.log('[module-registry] Iniciando boot de módulos...');

  const results = { enabled: [], disabled: [], failed: [], order: [] };

  const { ordered, cycles } = topologicalOrder();
  for (const cycle of cycles) {
    console.error(`[module-registry] CICLO de dependência: ${cycle}. Módulos envolvidos ficam de fora do boot.`);
  }
  results.order = ordered;

  for (const id of ordered) {
    const mod = _modules.get(id);
    const shouldEnable = process.env[mod.enabledBy] === 'true';

    if (!shouldEnable) {
      console.log(`[module-registry] [${mod.phase.toUpperCase()}] ${id}: DESATIVADO (${mod.enabledBy}=false ou não definido)`);
      _states.set(id, STATES.DISABLED);
      results.disabled.push(id);
      continue;
    }

    // Dependências obrigatórias. A ordenação topológica acima já garante que
    // toda dependência foi *tentada* antes desta linha, então um `_active`
    // vazio aqui significa que ela está desligada ou falhou — nunca que ainda
    // não chegou a vez dela, que era o modo de falha antigo.
    const missingDeps = mod.dependencies.filter(dep => !_active.has(dep));
    if (missingDeps.length > 0) {
      console.error(`[module-registry] ${id}: FALHOU — dependências não ativas: ${missingDeps.join(', ')}`);
      _states.set(id, STATES.FAILED);
      results.failed.push({ id, reason: `dependências ausentes: ${missingDeps.join(', ')}` });
      continue;
    }

    // Inicializar
    _states.set(id, STATES.INITIALIZING);
    try {
      await mod.initialize();
      _states.set(id, STATES.READY);
      _active.add(id);

      // Registrar comandos no command-registry
      for (const cmdDef of mod.commands) {
        commandRegistry.register(cmdDef.name, cmdDef.handler, {
          module: id,
          phase: mod.phase,
          description: cmdDef.description || '',
          usage: cmdDef.usage || cmdDef.name
        });
      }

      _states.set(id, STATES.RUNNING);
      const inativas = mod.optionalDependencies.filter(dep => !_active.has(dep));
      console.log(
        `[module-registry] [${mod.phase.toUpperCase()}] ${id}@${mod.version}: ATIVO ` +
        `(${mod.commands.length} comandos registrados` +
        `${inativas.length > 0 ? `, opcionais inativas: ${inativas.join(', ')}` : ''})`
      );
      results.enabled.push(id);
    } catch (err) {
      // Um módulo que falhou no meio do `initialize` pode já ter registrado
      // interações. Deixá-las no registro é pior que a falha em si: elas
      // aparecem no menu e executam contra um serviço que nunca inicializou.
      const orfas = interactionRegistry.unregisterModule(id);
      // `initialize` pode ter aberto timer/socket antes de falhar. Mesmo sem o
      // modulo ter chegado a `_active`, seu shutdown precisa ter a chance de
      // desfazer o boot parcial.
      try {
        await mod.shutdown();
      } catch (shutdownError) {
        console.error(
          `[module-registry] ${id}: falha ao limpar initialize parcial:`,
          shutdownError.message
        );
      }
      console.error(
        `[module-registry] ${id}: FALHOU ao inicializar:`, err.message +
        (orfas > 0 ? ` (${orfas} interações órfãs removidas)` : '')
      );
      _states.set(id, STATES.FAILED);
      results.failed.push({ id, reason: err.message });
    }
  }

  console.log(`[module-registry] Boot concluído: ${results.enabled.length} ativos, ${results.disabled.length} desativados, ${results.failed.length} com falha`);
  if (results.failed.length > 0) {
    console.error('[module-registry] Módulos com falha:', results.failed.map(f => `${f.id} (${f.reason})`).join('; '));
  }

  return results;
}

/**
 * Remove descritores de uma instancia ja encerrada antes do proximo boot.
 * Diferente de `_reset`, esta funcao e API de producao e recusa apagar modulo
 * ativo: o coordenador de runtime deve aguardar `shutdownAll()` primeiro.
 */
function prepareForBoot() {
  if (_active.size > 0) {
    throw new Error(
      `[module-registry] reload recusado: ${_active.size} modulo(s) ainda ativo(s)`
    );
  }
  _modules.clear();
  _states.clear();
}

/**
 * Desliga todos os módulos ativos ordenadamente.
 *
 * Ordem inversa à do boot: quem depende de alguém desliga antes de quem é
 * dependido. Sem isso, `governance` poderia sair enquanto `market-stalls` — que
 * o consome — ainda atende pedido.
 *
 * Chamado no shutdown do servidor.
 */
async function shutdownAll() {
  console.log('[module-registry] Iniciando shutdown de módulos...');
  const { ordered } = topologicalOrder();
  for (const id of [...ordered].reverse()) {
    const mod = _modules.get(id);
    if (!mod || !_active.has(id)) continue;
    _states.set(id, STATES.STOPPING);
    try {
      // Remover comandos do registry
      for (const cmdDef of mod.commands) {
        commandRegistry.unregister(cmdDef.name);
      }
      // E as interações registradas. Automático pelo mesmo motivo que os
      // comandos são: um módulo que precisa lembrar de limpar acaba esquecendo,
      // e o resultado é uma ação no menu apontando para um serviço desligado.
      interactionRegistry.unregisterModule(id);
      await mod.shutdown();
      _active.delete(id);
      _states.set(id, STATES.STOPPED);
      console.log(`[module-registry] ${id}: desligado`);
    } catch (err) {
      console.error(`[module-registry] Erro ao desligar ${id}:`, err.message);
      _states.set(id, STATES.FAILED);
      _active.delete(id);
    }
  }
}

/**
 * Executa healthCheck em todos os módulos ativos.
 * Retorna relatório para diagnóstico.
 */
function healthCheckAll() {
  const report = [];
  for (const [id, mod] of _modules.entries()) {
    if (!_active.has(id)) continue;
    try {
      const healthy = mod.healthCheck();
      report.push({ id, healthy });
    } catch (err) {
      report.push({ id, healthy: false, error: err.message });
    }
  }
  return report;
}

/**
 * Falha o boot quando um módulo CORE explicitamente habilitado não chegou a
 * RUNNING ou quando seu health check reprova. Módulos LAB continuam podendo
 * falhar de forma degradada e aparecem no relatório normal de boot.
 */
function assertCoreReady() {
  const issues = [];
  const healthById = new Map(healthCheckAll().map(item => [item.id, item]));

  for (const [id, mod] of _modules.entries()) {
    if (mod.phase !== 'core' || process.env[mod.enabledBy] !== 'true') continue;
    if (!_active.has(id)) {
      issues.push(`${id}: estado=${_states.get(id) || STATES.REGISTERED}`);
      continue;
    }

    const health = healthById.get(id);
    if (!health || health.healthy !== true) {
      issues.push(`${id}: healthCheck=${health?.error || String(health?.healthy)}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`[module-registry] Core sem readiness: ${issues.join('; ')}`);
  }
  return true;
}

/**
 * Lista todos os módulos registrados com seu status.
 */
function list() {
  return Array.from(_modules.values()).map(mod => ({
    id: mod.id,
    phase: mod.phase,
    version: mod.version,
    state: _states.get(mod.id) || STATES.REGISTERED,
    enabled: _active.has(mod.id),
    enabledBy: mod.enabledBy,
    envValue: process.env[mod.enabledBy] || 'não definido',
    dependencies: mod.dependencies,
    optionalDependencies: mod.optionalDependencies,
    commandCount: mod.commands.length
  }));
}

/** Só para teste: devolve o registry ao estado vazio entre casos. */
function _reset() {
  _modules.clear();
  _active.clear();
  _states.clear();
}

module.exports = {
  STATES,
  register, isEnabled, getState,
  bootAll, shutdownAll, healthCheckAll, assertCoreReady, list,
  topologicalOrder, prepareForBoot,
  _reset
};
