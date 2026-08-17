/**
 * death-service.js
 *
 * Morte e resgate com consequência real (Heavy RP).
 *
 * Antes: HP<=0 disparava um respawn automático 10s depois, sem estado, sem
 * penalidade, sem chance de outro jogador intervir — "morrer" era um
 * non-event mecânico. Agora:
 *
 *   HP<=0 → estado DOWNED (bloqueia gameplay/fala via core/action-policy.js,
 *           que já restringe esses estados) → ou:
 *     (a) outro jogador usa /socorrer <actorId> a tempo → volta pra NORMAL
 *         com uma pequena estabilização de vida; ou
 *     (b) ninguém socorre dentro de BLEED_OUT_MS → estado DEAD, penalidade
 *         de ouro é aplicada via core/transaction-service (atômico), um
 *         snapshot de quem estava por perto é gravado em audit_logs (evidência
 *         de RDM pra staff), e só então o personagem respawna no ponto seguro.
 */

const db = require('./database');
const commands = require('./commands');
const characterState = require('./core/character-state');
const { STATES } = characterState;
const transactionService = require('./core/transaction-service');
const panelRefreshBus = require('./core/panel-refresh-bus');
const rangeUtils = require('./core/range-utils');
const hitEvents = require('./core/hit-events');
const deathEvents = require('./core/death-events');
// Este arquivo ja usava a forma de objeto antes do achado 2.13 (era um dos
// dois que estavam certos). Passou a usar o helper pra que exista um lugar
// so onde a forma do `self` e decidida — enquanto a construcao estava
// duplicada aqui, corrigir `core/papyrus.js` nao alcancava este arquivo.
const { actorRef } = require('./core/papyrus');
const skymp = require('./core/skymp-adapter');

const RESPAWN_POS = [-150, -100, -200]; // Coordenadas ficticias do Templo de Kynareth

// FormID da celula de respawn (Templo de Kynareth).
//
// ⚠️ Era `RESPAWN_CELL = '0x162e2'`, e o `0x` nao e detalhe cosmetico.
// **[DOC]** `FormDesc.cpp` (`SKYMP_UPSTREAM_REFERENCE.md` §8.5): a forma
// canonica e hex **sem prefixo**, `:`, nome do arquivo — `"162e2:Skyrim.esm"`.
// E `FormDesc::FromString` **nao valida**: uma string sem `:` cai no ramo sem
// arquivo e resolve para `0xff000000 + id`, a faixa de forms gerados pelo
// servidor. Nao da erro, nao loga, e aponta para outro lugar. Ver §10 da
// `REVISAO_REALIDADE_COMPARTILHADA.md`.
//
// O numero em si continua **nao verificado in-game** — veio herdado e ninguem
// abriu o ESM para conferir que 0x162e2 e o Templo. O que esta rodada conserta e
// o formato, que era um defeito certo; o valor e observacao da Fase 0.
const RESPAWN_CELL_FORM_ID = 0x162e2;
const RESPAWN_CELL_FALLBACK = '162e2:Skyrim.esm';

/**
 * A celula de respawn como `FormDesc`.
 *
 * Derivada por `mp.getDescFromId` **[DOC]** (§8.3) quando disponivel, em vez de
 * escrita a mao: o servidor sabe de qual arquivo aquele FormID veio, e derivar
 * sobrevive a mudanca de load order. O literal fica so como rede — o
 * `market-stalls-service` ja trata `getDescFromId` como possivelmente ausente.
 */
function respawnCellDesc() {
  if (typeof mp !== 'undefined' && typeof mp.getDescFromId === 'function') {
    try {
      const desc = mp.getDescFromId(RESPAWN_CELL_FORM_ID);
      if (typeof desc === 'string' && desc) return desc;
    } catch (err) {
      console.error('[death-service] getDescFromId falhou para a celula de respawn:', err.message);
    }
  }
  return RESPAWN_CELL_FALLBACK;
}
const DEATH_PENALTY_COINS = 50;
const DEATH_PENALTY_PERCENTAGE = 0.1; // 10% do ouro atual, o que for maior

const serverOptions = require('./core/server-options');

const BLEED_OUT_MS = 4 * 60 * 1000; // janela de socorro: 4 minutos
// Pausa entre "morreu" e respawn. Configurável em `spawn.playerRespawnSeconds`.
const RESPAWN_DELAY_MS = serverOptions.get('spawn.playerRespawnSeconds') * 1000;
const RESCUE_RANGE = 300;
// Mesmo raio da fala normal: quem podia ouvir a cena é quem entra na evidência.
const DEATH_CONTEXT_RANGE = require('./core/proximity-ranges').RANGES.say;
const STABILIZE_HEALTH = 25;
const INITIATE_RANGE = 800;
const DAMAGE_SPIKE_THRESHOLD = 25; // heurística: pontos de vida perdidos num único tick de 2s

// characterId -> { actorId, downedAt, timer }
const _downedPlayers = new Map();
// actorId -> última leitura de Health (pra detectar picos de dano)
const _lastHealth = new Map();
// characterId -> quem o derrubou, capturado por `mp.onDeath` no instante da
// queda. Precisa sobreviver até o bleed-out, que acontece minutos depois.
const _killers = new Map();
let _healthPollTimer = null;
let _initialized = false;
const _deferredTimers = new Set();

function scheduleDeferred(callback, delayMs) {
  const timer = setTimeout(() => {
    _deferredTimers.delete(timer);
    callback();
  }, delayMs);
  _deferredTimers.add(timer);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function cancelDeferred(timer) {
  if (!timer) return;
  clearTimeout(timer);
  _deferredTimers.delete(timer);
}

/**
 * Grava um episódio de agressão relatado pelo cliente.
 *
 * É evidência, não atribuição definitiva: o evento vem de `makeEventSource`,
 * que roda na máquina do jogador (`CONTRIBUTING.md` §3.6). Vale como rastro
 * pra staff arbitrar denúncia de RDM — e é estritamente melhor que o
 * `checkDamageSpike`, que chama de agressão qualquer queda de 25 de vida e não
 * sabe dizer quem bateu.
 *
 * Uma linha por episódio, não por golpe: ver a explicação em core/hit-events.js.
 */
async function logCombatEpisode(episodio) {
  const agressor = commands.getActiveCharacterData(episodio.agressor);
  const alvo = commands.getActiveCharacterData(episodio.alvo);

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'combat:episode',
        agressor?.accountId || null,
        alvo?.accountId || null,
        JSON.stringify({
          agressorCharacterId: agressor?.characterId || null,
          alvoCharacterId: alvo?.characterId || null,
          golpes: episodio.golpes,
          powerAttacks: episodio.powerAttacks,
          sneakAttacks: episodio.sneakAttacks,
          bashAttacks: episodio.bashAttacks,
          bloqueados: episodio.bloqueados,
          duracaoMs: episodio.duracaoMs,
          // Deixa explicito na propria evidencia de onde ela veio, pra que
          // ninguem a trate como prova numa arbitragem.
          origem: 'cliente (makeEventSource) — evidencia, nao prova'
        })
      ]
    );
  } catch (err) {
    console.error('[death-service] Falha ao registrar episodio de combate:', err.message);
  }
}

function initDeathService() {
  if (typeof mp === 'undefined') return;
  if (_initialized) return;
  _initialized = true;
  console.log('[death-service] Initializing Death and Respawn hooks...');

  // Agressão relatada pelo cliente. Substitui, quando confirmado in-game, a
  // heurística de `checkDamageSpike` — que só existe porque estava pendurada
  // no polling. Ver core/hit-events.js.
  hitEvents.start((episodio) => {
    logCombatEpisode(episodio).catch(err =>
      console.error('[death-service] Falha no episodio de combate:', err.message)
    );
  });

  // ── Caminho primário: o hook nativo ────────────────────────────────────────
  //
  // `mp.onDeath` existe desde sempre e este projeto não usava — a evidência
  // está em `misc/tests/test_isdead.js` do repositório upstream. Ele entrega
  // duas coisas que o polling nunca daria:
  //
  //   1. O momento exato da morte, no frame em que acontece. O polling de 2s
  //      atrasava o `DOWNED` em até dois segundos, o que numa cena de RP é a
  //      diferença entre a cena funcionar e não funcionar.
  //   2. `killerId` — quem matou. A documentação de combate deste projeto
  //      chegou a registrar que "não há hook confiável de quem atacou quem";
  //      para o momento da morte, há. É atribuição direta, não a inferência
  //      por proximidade que o `logDeathContext` faz.
  //
  // `killerId` é `0` quando não há autor: queda, veneno, afogamento.
  //
  // ⚠️ Isto era `mp.onDeath = (...) => {...}` — atribuição direta, e portanto
  // posse exclusiva do hook. Passou a ser uma assinatura em
  // `core/death-events.js` em 08/08/2026, antes de existir um segundo
  // consumidor, porque o segundo consumidor já está previsto: o
  // `hunting-service` do `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.3 precisa do
  // mesmo hook para um pipeline separado (§11.4). Com a atribuição direta, ele
  // teria apagado esta linha em silêncio, e a morte de jogador pararia de ser
  // detectada pelo caminho primário sem erro nenhum — o polling de 2 s abaixo
  // disfarçaria com dois segundos de atraso.
  //
  // `handlePlayerDowned` já sai em O(1) quando o ator não é um personagem ativo
  // (`getActiveCharacterData` devolve undefined), que é o requisito da §7.2:
  // com fauna ativa este hook dispara constantemente, e o caminho de morte não
  // pode tocar o banco antes de decidir que o assunto é dele.
  //
  // ⚠️ O retorno deste handler decide se o SERVIDOR respawna o ator sozinho.
  // Ver o contrato em `core/death-events.js`. Devolver `false` é o que impede
  // `DeathEvent::OnFireSuccess` de chamar `RespawnWithDelay()` — sem isso, o
  // jogador levanta aos 25 s (o `spawnDelay` padrao do upstream) no meio dos 4
  // minutos de bleed-out, e passam a existir duas autoridades sobre o mesmo
  // estado. Era o bloqueador de Fase 0 da `REVISAO_REALIDADE_COMPARTILHADA.md`
  // §6.2.
  //
  // A reivindicacao e SINCRONA e O(1) de proposito: o motor le o retorno no
  // mesmo frame, entao ela nao pode esperar `handlePlayerDowned` (que e async e
  // toca o banco). `getActiveCharacterData` responde do cache em memoria, que e
  // exatamente a mesma checagem que `handlePlayerDowned` faz primeiro.
  //
  // So reivindica personagem ativo. Um lobo morto nao tem `characterData`, o
  // retorno fica `undefined`, e o servidor respawna a fauna normalmente — que e
  // o requisito da §7.2 do `HOSTILE_MOB_ACTIVATION_DECISION.md` e a razao de o
  // barramento agregar retorno em vez de bloquear tudo.
  deathEvents.subscribe('death-service', (actorId, killerId) => {
    try {
      const nossa = Boolean(commands.getActiveCharacterData(actorId));

      handlePlayerDowned(actorId, killerId).catch(err =>
        console.error('[death-service] Falha ao processar queda (onDeath):', err.message)
      );

      // Assumimos o ciclo inteiro: `/socorrer` devolve ao jogo, e o bleed-out
      // chama `executeRespawn`, que e o unico caminho com penalidade, transicao
      // de estado e refresh de painel. O respawn nativo nao faz nada disso —
      // por isso ele e bloqueado, e nao apenas reagendado.
      return nossa ? false : undefined;
    } catch (err) {
      console.error('[death-service] Erro no hook onDeath:', err.message);
      // Erro nosso nao pode virar decisao de mundo: sem reivindicacao, o
      // servidor faz o que faria sem este modulo.
      return undefined;
    }
  });

  // ── Rede de segurança: o polling que existia antes ─────────────────────────
  //
  // Mantido de propósito, por dois motivos:
  //
  //   - `mp.onDeath` ainda não foi confirmado numa sessão real deste servidor.
  //     Se ele não disparar como esperado, o polling ainda pega a queda — com
  //     atraso, mas pega. `handlePlayerDowned` é idempotente por personagem
  //     (`_downedPlayers`), então os dois caminhos juntos não duplicam nada.
  //   - `checkDamageSpike` depende de ler vida ao longo do tempo, e não tem
  //     equivalente em `onDeath`: ele existe pra registrar agressão que NÃO
  //     matou.
  //
  // Quando o teste in-game confirmar o `onDeath`, o laço pode virar só o
  // `checkDamageSpike` — ou sair de vez, se o evento de hit por
  // `makeEventSource` substituir a heurística. Ver
  // docs/technical/SKYMP_UPSTREAM_REFERENCE.md 2.5.
  _healthPollTimer = setInterval(() => {
    try {
      // Para cada profileId de player 1..50
      for (let pId = 1; pId <= 50; pId++) {
        const actors = mp.getActorsByProfileId(pId);
        if (!actors || actors.length === 0) continue;

        for (const actorId of actors) {
          const health = mp.callPapyrusFunction('method', 'Actor', 'getActorValue', actorRef(actorId), ['Health']);
          const currentlyDead = (health <= 0);
          const wasDead = mp.get(actorId, '_wasDead') || false;

          if (currentlyDead && !wasDead) {
            handlePlayerDowned(actorId).catch(err => console.error('[death-service] Falha ao processar queda:', err.message));
            mp.set(actorId, '_wasDead', true);
          } else if (!currentlyDead && wasDead) {
            mp.set(actorId, '_wasDead', false);
          }

          checkDamageSpike(actorId, health);
        }
      }
    } catch (err) {
      console.error('[death-service] Error polling health:', err.message);
    }
  }, 2000);
  if (typeof _healthPollTimer.unref === 'function') _healthPollTimer.unref();
}

function shutdownDeathService() {
  if (_healthPollTimer) clearInterval(_healthPollTimer);
  _healthPollTimer = null;
  deathEvents.unsubscribe('death-service');
  hitEvents.stop();

  for (const downed of _downedPlayers.values()) cancelDeferred(downed.timer);
  for (const timer of [..._deferredTimers]) cancelDeferred(timer);
  _downedPlayers.clear();
  _lastHealth.clear();
  _killers.clear();
  _initialized = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queda → DOWNED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {number} actorId
 * @param {number} [killerId] FormID de quem matou, vindo de `mp.onDeath`.
 *   `0`/ausente quando não há autor (queda, veneno) ou quando a queda veio pelo
 *   polling, que não sabe quem foi.
 */
async function handlePlayerDowned(actorId, killerId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) return;
  if (_downedPlayers.has(character.characterId)) return; // já processando esta queda

  console.log(`[death-service] Player Actor ${actorId.toString(16)} caiu. Estado: DOWNED.`);
  characterState.set(character.characterId, STATES.DOWNED, { downedAt: Date.now() });
  commands.broadcastProximityMessage(actorId, '* O corpo cai ao chão, ferido e sangrando.', 1500);
  panelRefreshBus.requestRefresh(actorId, 'status');

  // Registra a autoria no instante em que ela é conhecida. Guardar junto do
  // estado, e não só no log, é o que permite ao `bleedOut` gravar quem matou
  // mesmo minutos depois — a informação vem do hook e não se recupera sozinha.
  await logKiller(actorId, character.characterId, killerId);

  const timer = scheduleDeferred(() => {
    bleedOut(actorId, character.characterId).catch(err => console.error('[death-service] Falha no bleed-out:', err.message));
  }, BLEED_OUT_MS);

  _downedPlayers.set(character.characterId, { actorId, downedAt: Date.now(), timer });
}

// ─────────────────────────────────────────────────────────────────────────────
// Socorro (comando /socorrer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estabiliza um alvo DOWNED próximo, cancelando o bleed-out.
 * @param {number} rescuerActorId
 * @param {number} targetActorId
 */
async function rescueTarget(rescuerActorId, targetActorId) {
  if (rescuerActorId === targetActorId) {
    commands.sendNotification(rescuerActorId, 'Voce nao pode se socorrer sozinho — peça ajuda a alguém por perto.');
    return;
  }

  const rescuer = commands.getActiveCharacterData(rescuerActorId);
  const target = commands.getActiveCharacterData(targetActorId);
  if (!rescuer || !target) {
    commands.sendNotification(rescuerActorId, 'Alvo invalido.');
    return;
  }

  const downed = _downedPlayers.get(target.characterId);
  if (!downed) {
    commands.sendNotification(rescuerActorId, 'Esse personagem nao esta abatido.');
    return;
  }

  const range = rangeUtils.assertRange(rescuerActorId, targetActorId, RESCUE_RANGE);
  if (!range.ok) {
    commands.sendNotification(rescuerActorId, range.reason);
    return;
  }

  cancelDeferred(downed.timer);
  _downedPlayers.delete(target.characterId);
  // Socorrido a tempo: não houve morte, então a autoria deixa de ser relevante
  // (e o registro em audit_logs já guarda o que aconteceu, se a staff precisar).
  _killers.delete(target.characterId);

  characterState.set(target.characterId, STATES.NORMAL, {});
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('method', 'Actor', 'Resurrect', actorRef(targetActorId), []);
    mp.callPapyrusFunction('method', 'Actor', 'SetActorValue', actorRef(targetActorId), ['Health', STABILIZE_HEALTH]);
    mp.set(targetActorId, '_wasDead', false);
  }

  commands.sendNotification(rescuerActorId, 'Voce estabilizou o ferido.');
  commands.sendNotification(targetActorId, 'Voce foi socorrido e recobra a consciencia, fraco.');
  commands.broadcastProximityMessage(rescuerActorId, '* Presta socorro a um ferido caído por perto.', 600);
  panelRefreshBus.requestRefresh(targetActorId, 'status');
}

// ─────────────────────────────────────────────────────────────────────────────
// Bleed-out → penalidade + respawn
// ─────────────────────────────────────────────────────────────────────────────

async function bleedOut(actorId, characterId) {
  _downedPlayers.delete(characterId);
  console.log(`[death-service] Personagem ${characterId} sangrou ate a morte sem socorro.`);

  characterState.set(characterId, STATES.DEAD, {});
  await logDeathContext(actorId, characterId, 'bleed_out');
  // O contexto já foi gravado com a autoria; a partir daqui o mapa não é mais
  // necessário e mantê-lo vazaria memória a cada morte.
  _killers.delete(characterId);

  const gold = await transactionService.getGold(characterId);
  const penalty = Math.min(gold, Math.max(DEATH_PENALTY_COINS, Math.floor(gold * DEATH_PENALTY_PERCENTAGE)));
  if (penalty > 0) {
    await transactionService.removeGold({ characterId, amount: penalty, reason: 'death_penalty', module: 'death' });
  }

  commands.broadcastProximityMessage(actorId, '* O corpo para de se mexer.', 1500);
  panelRefreshBus.requestRefresh(actorId, 'status');

  // Morte permanente: o personagem não respawna, é aposentado. Mesmo caminho do
  // /permakill da staff (`status='retired'`, nunca DELETE) — a diferença é que
  // aqui quem decidiu foi a mecânica, não uma pessoa, então o motivo registrado
  // no audit log diz isso.
  //
  // Desligado por padrão. Ligar isto muda o significado de toda cena de
  // combate do servidor, então é uma decisão de operação, não um detalhe.
  if (serverOptions.get('rp.permadeathEnabled')) {
    await retireOnPermadeath(actorId, characterId);
    return penalty;
  }

  scheduleDeferred(() => {
    executeRespawn(actorId, characterId, penalty).catch(err => console.error('[death-service] Falha no respawn:', err.message));
  }, RESPAWN_DELAY_MS);

  return penalty;
}

/**
 * Aposenta o personagem por morte permanente.
 *
 * Não reaproveita `admin-service.retireCharacter` de propósito: aquele valida
 * permissão de staff e exige um actorId de quem executou. Aqui não há
 * executor — quem aposentou foi a regra do servidor.
 */
async function retireOnPermadeath(actorId, characterId) {
  try {
    await db.query('UPDATE characters SET status = ? WHERE id = ?', ['retired', characterId]);
    await db.query(
      'INSERT INTO audit_logs (action, target_account_id, details) VALUES (?, NULL, ?)',
      ['death:permadeath', `characterId=${characterId} motivo=bleed_out com rp.permadeathEnabled`]
    );

    commands.sendNotification(
      actorId,
      'Seu personagem morreu permanentemente. Ele nao volta — crie um novo pelo painel.'
    );
    console.log(`[death-service] PERMADEATH: personagem ${characterId} aposentado.`);

    // Kick com folga pra mensagem ser lida. `whitelist.js` só libera spawn com
    // `status='approved'`, então uma reconexão já não encontra este personagem.
    if (typeof mp !== 'undefined') {
      scheduleDeferred(() => {
        // `mp.kick` recebe `userId`, nao FormID; o adaptador converte pelo
        // `getUserByActor`. Ver docs/research/SKYMP_INTEGRATION_AUDIT.md §6.
        try { skymp.kick(actorId); } catch (err) { console.error('[death-service] Falha ao kickar apos permadeath:', err.message); }
      }, 8000);
    }
  } catch (err) {
    console.error('[death-service] Falha ao aposentar personagem por permadeath:', err.message);
  }
}

async function executeRespawn(actorId, characterId, penalty = 0) {
  if (typeof mp === 'undefined') return;

  try {
    mp.callPapyrusFunction('method', 'Actor', 'Resurrect', actorRef(actorId), []);

    // ⚠️ As tres chaves e os tres tipos sao exigencia do addon nativo, nao
    // convencao nossa. **[DOC]** `LocationalDataBinding::Set` (§8.4) le
    // `cellOrWorldDesc` (string), `pos` (array) e `rot` (array) via
    // `NapiHelper::ExtractString` / `ExtractNiPoint3`, que **lancam** quando o
    // tipo nao bate. Este objeto era `{ pos, worldOrCell, angleZ }`: sem
    // `cellOrWorldDesc`, `Get()` devolvia `undefined`, que nao e string, e o
    // `mp.set` lancava — derrubando as linhas seguintes junto (`_wasDead`,
    // `characterState`, notificacao, painel). O `catch` abaixo engolia como
    // "Failed to respawn actor" e o personagem ficava ressuscitado onde caiu,
    // com o estado travado em DEAD.
    //
    // A forma certa ja estava declarada em `types/mp.d.ts` e ja era usada pelo
    // `governance-service` ao prender alguem. O `typecheck` e informativo
    // (`ARCHITECTURE.md` §1.4), entao nunca reclamou da divergencia.
    mp.set(actorId, 'locationalData', {
      cellOrWorldDesc: respawnCellDesc(),
      pos: RESPAWN_POS,
      rot: [0, 0, 0]
    });
    mp.set(actorId, '_wasDead', false);

    characterState.set(characterId, STATES.NORMAL, {});
    console.log(`[death-service] Respawn complete for actor ${actorId.toString(16)}.`);

    commands.sendNotification(actorId, penalty > 0
      ? `Voce foi resgatado e acordou em um local seguro. Perdeu ${penalty} septims no processo.`
      : 'Voce foi resgatado e acordou em um local seguro.');
    panelRefreshBus.requestRefresh(actorId, 'status');
  } catch (err) {
    console.error(`[death-service] Failed to respawn actor ${actorId.toString(16)}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidência anti-RDM: quem estava por perto na hora da morte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Não existe hook nativo confiável de "quem causou o dano" nesta base — o
 * contexto é por proximidade (mesmo padrão de commands.broadcastProximityMessage),
 * não uma atribuição definitiva. Ainda assim dá à staff uma trilha real pra
 * arbitrar denúncias de RDM, em vez de só a palavra dos jogadores.
 */
/**
 * Registra quem matou, quando o hook `mp.onDeath` informa.
 *
 * É a diferença entre evidência e atribuição. O `logDeathContext` lista quem
 * estava por perto — útil, mas circunstancial: numa briga de cinco pessoas,
 * cinco nomes aparecem e a staff decide no olho. Aqui é o servidor dizendo
 * quem foi.
 *
 * Guarda também em `_killers` porque a morte definitiva (`bleedOut`) acontece
 * até quatro minutos depois, e o `killerId` só existe neste instante.
 */
async function logKiller(actorId, characterId, killerId) {
  if (!killerId) return null; // 0 ou ausente: queda, veneno, ou veio do polling

  const killerChar = commands.getActiveCharacterData(killerId);
  const killer = {
    actorId: killerId,
    characterId: killerChar ? killerChar.characterId : null,
    // Sem personagem carregado, o agressor é um NPC ou um ator do mundo — o
    // que por si só já é informação pra staff (morte por NPC não é RDM).
    name: killerChar ? `${killerChar.firstName} ${killerChar.lastName}` : null
  };

  _killers.set(characterId, killer);

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      ['death:killer', killerChar?.accountId || null, null, JSON.stringify({ characterId, killer })]
    );
  } catch (err) {
    console.error('[death-service] Falha ao registrar autoria da morte:', err.message);
  }

  return killer;
}

async function logDeathContext(actorId, characterId, cause) {
  const nearby = rangeUtils.nearbyActors(actorId, DEATH_CONTEXT_RANGE)
    .map(({ actorId: neighborId, distance }) => {
      const neighborChar = commands.getActiveCharacterData(neighborId);
      if (!neighborChar) return null;
      return {
        characterId: neighborChar.characterId,
        name: `${neighborChar.firstName} ${neighborChar.lastName}`,
        distance: Math.round(distance)
      };
    })
    .filter(Boolean);

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      // `killer` vem do hook nativo (atribuição); `nearby` é proximidade
      // (circunstancial). Guardar os dois no mesmo registro deixa claro pra
      // staff qual é qual.
      ['death:context', null, null, JSON.stringify({ characterId, cause, killer: _killers.get(characterId) || null, nearby })]
    );
  } catch (err) {
    console.error('[death-service] Falha ao registrar contexto de morte:', err.message);
  }

  return nearby;
}

// ─────────────────────────────────────────────────────────────────────────────
// Camada mínima de RP pro combate
//
// Não há hook nativo confiável de "quem atacou quem" nesta base (mesma
// limitação do contexto de morte acima). Em vez de simular enforcement que
// não dá pra garantir, isso cobre duas coisas honestamente buildáveis:
//   (a) /iniciar — marcação explícita de abertura de conflito IC, criada
//       pelo próprio jogador, pra dar à staff evidência de que houve (ou
//       não houve) RP de abertura antes de um confronto;
//   (b) detecção automática de picos de dano via o mesmo polling de HP já
//       usado pra morte, registrando quem estava por perto — funciona
//       mesmo se ninguém usar /iniciar.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * /iniciar <actorId> <motivo> — registra em audit_logs uma marcação
 * explícita de início de conflito IC entre dois jogadores próximos.
 */
async function logCombatInitiation(actorId, targetActorId, reason) {
  const initiator = commands.getActiveCharacterData(actorId);
  const target = commands.getActiveCharacterData(targetActorId);
  if (!initiator || !target || actorId === targetActorId) {
    commands.sendNotification(actorId, 'Alvo invalido.');
    return;
  }
  if (!reason || !reason.trim()) {
    commands.sendNotification(actorId, 'Uso: /iniciar <actorId> <motivo>');
    return;
  }

  const range = rangeUtils.assertRange(actorId, targetActorId, INITIATE_RANGE);
  if (!range.ok) {
    commands.sendNotification(actorId, range.reason);
    return;
  }

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'combat:initiate',
        initiator.accountId,
        target.accountId,
        JSON.stringify({ initiatorCharacterId: initiator.characterId, targetCharacterId: target.characterId, reason })
      ]
    );
  } catch (err) {
    console.error('[death-service] Falha ao registrar inicio de combate:', err.message);
  }

  commands.sendNotification(actorId, 'Inicio de combate registrado.');
  commands.broadcastProximityMessage(actorId, '* A tensao sobe visivelmente entre os dois.', 800);
}

/**
 * Detecta uma queda brusca de vida (heurística: >= DAMAGE_SPIKE_THRESHOLD
 * pontos num único tick de 2s) e registra o mesmo tipo de contexto de
 * proximidade usado na morte — cria um rastro mesmo sem /iniciar.
 */
function checkDamageSpike(actorId, health) {
  const previous = _lastHealth.has(actorId) ? _lastHealth.get(actorId) : health;
  _lastHealth.set(actorId, health);

  if (health <= 0 || previous - health < DAMAGE_SPIKE_THRESHOLD) return;

  const character = commands.getActiveCharacterData(actorId);
  if (!character) return;

  logDeathContext(actorId, character.characterId, 'damage_spike').catch(
    err => console.error('[death-service] Falha ao registrar pico de dano:', err.message)
  );
}

/**
 * Esquece a última leitura de vida de um actorId (chamar na desconexão).
 *
 * `_lastHealth` é chaveado por actorId, e o SkyMP reaproveita actorId entre
 * sessões — mesma classe de bug do `staffCache` do admin-service, que fazia
 * quem entrasse depois herdar o cargo de um admin que já tinha saído.
 *
 * Aqui o efeito era pior porque é silencioso: se alguém sai com 500 de vida e
 * o slot é reaproveitado por outro jogador que entra com 100, o primeiro tick
 * de `checkDamageSpike` lê `previous = 500`, calcula uma queda de 400 e grava
 * um `damage_spike` no contexto de morte. O novo jogador aparece como tendo
 * apanhado de alguém sem ter levado um golpe — e essa linha é justamente o que
 * a staff usa pra arbitrar denúncia de RDM. O caso inverso (sair ferido, entrar
 * cheio) esconde uma agressão real, porque a diferença fica negativa.
 *
 * @param {number} actorId
 */
function cleanup(actorId) {
  _lastHealth.delete(actorId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: ['/socorrer', '/rescue'],
      description: 'Estabiliza um personagem abatido por perto, cancelando o sangramento',
      usage: '/socorrer <actorId>',
      handler: (actorId, args) => {
        const targetActorId = Number.parseInt(String(args || '').replace(/^0x/i, ''), 16);
        if (!Number.isFinite(targetActorId)) {
          commands.sendNotification(actorId, 'Uso: /socorrer <actorId>');
          return;
        }
        rescueTarget(actorId, targetActorId).catch(err => {
          console.error('[death-service] Falha ao processar socorro:', err.message);
          commands.sendNotification(actorId, 'Nao foi possivel prestar socorro.');
        });
      }
    },
    {
      name: ['/iniciar', '/initiate'],
      description: 'Marca o início explícito de um conflito IC (evidência pra staff)',
      usage: '/iniciar <actorId> <motivo>',
      handler: (actorId, args) => {
        const parts = String(args || '').split(' ');
        const targetActorId = Number.parseInt(parts[0].replace(/^0x/i, ''), 16);
        const reason = parts.slice(1).join(' ');
        if (!Number.isFinite(targetActorId)) {
          commands.sendNotification(actorId, 'Uso: /iniciar <actorId> <motivo>');
          return;
        }
        logCombatInitiation(actorId, targetActorId, reason).catch(err => {
          console.error('[death-service] Falha ao registrar inicio de combate:', err.message);
          commands.sendNotification(actorId, 'Nao foi possivel registrar o inicio do conflito.');
        });
      }
    }
  ];
}

module.exports = {
  commandDefs,
  initDeathService,
  shutdownDeathService,
  rescueTarget,
  bleedOut,
  executeRespawn,
  logDeathContext,
  logCombatInitiation,
  checkDamageSpike,
  cleanup,
  retireOnPermadeath,
  logKiller,
  logCombatEpisode,
  isDowned: (characterId) => _downedPlayers.has(characterId),
  // Exposto só pra testes: evita depender de setTimeout real pra exercitar o fluxo.
  _handlePlayerDowned: handlePlayerDowned,
  _respawnCellDesc: respawnCellDesc,
  RESPAWN_CELL_FALLBACK,
  _downedPlayers,
  _lastHealth,
  _killers
};
