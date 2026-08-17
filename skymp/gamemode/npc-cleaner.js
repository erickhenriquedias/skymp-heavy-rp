/**
 * npc-cleaner.js — remocao seletiva de NPCs vanilla
 *
 * ─── O que este arquivo fazia antes, e por que mudou ────────────────────────
 *
 * A versao anterior varria `mp.getActorsByProfileId(0)` e chamava `disable` +
 * `delete` em **todo** ator que encontrasse, pulando apenas os que estivessem
 * numa allowlist — que estava vazia, com um comentario "adicione IDs base de
 * mercadores essenciais aqui". Ou seja: apagava mercadores, guardas e NPCs de
 * quest, a cada 60 segundos, e `delete` numa referencia persistente nao volta.
 *
 * Isso contradizia a decisao registrada em `docs/technical/NPC_POLICY_DECISION.md`,
 * que avaliou tres opcoes e escolheu a **C — Vanilla Spawn Seletivo** ("NPCs
 * devem existir onde ajudam ambientacao e onboarding; NPCs que geram loot,
 * combate repetitivo ou conflito com papeis de jogadores devem ser removidos,
 * congelados ou substituidos"). O codigo implementava a opcao B, rejeitada, na
 * sua forma mais extrema.
 *
 * Tres inversoes:
 *
 *   1. **Allowlist virou blocklist.** So sai do mundo o que estiver listado. A
 *      lista vazia agora significa "nao remove nada" em vez de "remove tudo" —
 *      o modo de falha aponta pro lado seguro.
 *   2. **`safeRadius` passou a existir de verdade.** Era declarado no config
 *      com o comentario "limpa apenas NPCs longe dos players para nao quebrar
 *      imersao brusca" e nunca era lido. O comentario descrevia um recurso que
 *      nao estava escrito.
 *   3. **`delete` saiu.** `disable` e reversivel (`enable` traz de volta);
 *      `delete` numa referencia persistente e definitivo. Enquanto a curadoria
 *      da secao 4 do NPC_POLICY nao existir, nada aqui deve ser irreversivel.
 *
 * ─── Sobre o formato da lista ───────────────────────────────────────────────
 *
 * A lista guarda `baseDesc` ("1a6a0:Skyrim.esm"), nunca FormID numerico. O
 * primeiro byte de um FormID e o indice de load order, entao o mesmo numero
 * aponta pra records diferentes em clientes com load order diferente — e o
 * contrato de FormID (`MODS_AND_GAMEMODE_CONTRACT.md` secao 3) existe
 * justamente por causa disso. O desc carrega o plugin dentro do proprio valor.
 *
 * (A allowlist antiga comparava `mp.get(actorId, 'baseDesc')` — uma string —
 * contra um Set descrito como "IDs base". Mesmo preenchida, nunca teria
 * casado.)
 */

const fs = require('fs');
const path = require('path');
const { actorRef } = require('./core/papyrus');
const rangeUtils = require('./core/range-utils');

const POLICY_PATH = path.resolve(__dirname, '../config/npc-policy.json');

// Faixa de profileId varrida em busca de jogadores conectados, pro safeRadius.
// Mesmo teto usado em phase0-basic.js e death-service.js.
const MAX_PLAYER_PROFILE_ID = 50;

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  blockedBaseDescs: [],
  safeRadius: 5000,
  sweepIntervalMs: 60000,
  mode: 'disable'
});

let _sweepTimer = null;

/**
 * Le `skymp/config/npc-policy.json`. Ausencia do arquivo nao e erro — o
 * default e inerte, que e o estado correto ate a curadoria acontecer.
 *
 * @returns {{enabled: boolean, blockedBaseDescs: Set<string>, safeRadius: number, sweepIntervalMs: number, mode: string}}
 */
function loadPolicy() {
  let raw = {};
  if (fs.existsSync(POLICY_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    } catch (err) {
      // Config quebrada nao pode virar "remove tudo" nem "remove ao acaso":
      // volta pro default inerte e grita.
      console.error(`[npc-cleaner] ${POLICY_PATH} nao e JSON valido (${err.message}). Servico fica inerte.`);
      raw = {};
    }
  }

  const bloqueados = Array.isArray(raw.blockedBaseDescs) ? raw.blockedBaseDescs : [];
  const safeRadius = Number(raw.safeRadius);
  const sweepIntervalMs = Number(raw.sweepIntervalMs);

  return {
    enabled: raw.enabled === true,
    blockedBaseDescs: new Set(bloqueados.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim())),
    // `Number.isFinite` recusa Infinity e NaN de proposito: um raio infinito
    // protegeria todo mundo (servico inerte disfarcado de ativo) e um NaN
    // faria toda comparacao dar false (protegeria ninguem). Os dois sao piores
    // que o default.
    safeRadius: Number.isFinite(safeRadius) && safeRadius >= 0 ? safeRadius : DEFAULT_POLICY.safeRadius,
    sweepIntervalMs: Number.isFinite(sweepIntervalMs) && sweepIntervalMs >= 1000
      ? sweepIntervalMs
      : DEFAULT_POLICY.sweepIntervalMs,
    // Só 'disable' é aceito. Ver o cabeçalho: 'delete' não é uma opção.
    mode: 'disable'
  };
}

/**
 * actorIds de jogadores conectados, pra medir o safeRadius contra eles.
 * @returns {number[]}
 */
function _onlinePlayerActorIds() {
  const ids = [];
  for (let profileId = 1; profileId <= MAX_PLAYER_PROFILE_ID; profileId++) {
    const atores = mp.getActorsByProfileId(profileId);
    if (atores && atores.length > 0) ids.push(...atores);
  }
  return ids;
}

/**
 * Decide se um NPC pode ser removido agora.
 *
 * Separado do laco pra ser testavel sem `mp`: e aqui que mora a regra, e
 * regra de remocao permanente merece teste direto.
 *
 * @param {string|null} baseDesc          `mp.get(npcActorId, 'baseDesc')`
 * @param {number} distanciaAoJogadorMaisProximo  `Infinity` se nao ha ninguem por perto
 * @param {{blockedBaseDescs: Set<string>, safeRadius: number}} policy
 * @returns {boolean}
 */
function _shouldRemove(baseDesc, distanciaAoJogadorMaisProximo, policy) {
  if (!baseDesc) return false;
  if (!policy.blockedBaseDescs.has(baseDesc)) return false;
  return distanciaAoJogadorMaisProximo > policy.safeRadius;
}

/**
 * Distancia do NPC ao jogador conectado mais proximo.
 * `Infinity` quando nao ha jogador algum, ou quando todos estao em outra
 * celula (`range-utils.distanceBetween` ja devolve Infinity nesse caso).
 */
function _distanciaAoJogadorMaisProximo(npcActorId, jogadores) {
  let menor = Infinity;
  for (const jogadorId of jogadores) {
    const d = rangeUtils.distanceBetween(npcActorId, jogadorId);
    if (d === null) continue; // posicao indisponivel: nao conta como "perto"
    if (d < menor) menor = d;
  }
  return menor;
}

/**
 * Uma passada. Exportada pra teste e pra permitir execucao manual pela staff.
 * @param {object} [policy] - default: le do disco
 * @returns {{avaliados: number, removidos: number, protegidosPorDistancia: number}}
 */
function sweepOnce(policy = loadPolicy()) {
  const relatorio = { avaliados: 0, removidos: 0, protegidosPorDistancia: 0 };
  if (typeof mp === 'undefined') return relatorio;

  // Sem nada bloqueado nao ha o que fazer — e nem vale varrer o mundo.
  if (policy.blockedBaseDescs.size === 0) return relatorio;

  const npcs = mp.getActorsByProfileId(0) || [];
  const jogadores = _onlinePlayerActorIds();

  for (const npcActorId of npcs) {
    if (!npcActorId) continue;
    relatorio.avaliados++;

    const baseDesc = mp.get(npcActorId, 'baseDesc');
    if (!baseDesc || !policy.blockedBaseDescs.has(baseDesc)) continue;

    const distancia = _distanciaAoJogadorMaisProximo(npcActorId, jogadores);
    if (!_shouldRemove(baseDesc, distancia, policy)) {
      relatorio.protegidosPorDistancia++;
      continue;
    }

    // `disable(false)` — o argumento e `abFadeOut`. Sem delete: ver cabecalho.
    mp.callPapyrusFunction('method', 'ObjectReference', 'disable', actorRef(npcActorId), [false]);
    relatorio.removidos++;
  }

  return relatorio;
}

function startWorldCleaner(policy = loadPolicy()) {
  if (typeof mp === 'undefined') return false;
  if (_sweepTimer) return false;

  if (!policy.enabled) {
    console.log('[npc-cleaner] Desligado (npc-policy.json ausente ou enabled=false). Nenhum NPC sera tocado.');
    return false;
  }
  if (policy.blockedBaseDescs.size === 0) {
    console.warn(
      '[npc-cleaner] enabled=true, mas blockedBaseDescs esta vazia — nenhum NPC sera removido. ' +
      'Isto e deliberado: a lista e de BLOQUEIO. Preencha depois da curadoria da secao 4 de NPC_POLICY_DECISION.md.'
    );
    return false;
  }

  console.log(
    `[npc-cleaner] Ativo: ${policy.blockedBaseDescs.size} record(s) bloqueado(s), ` +
    `safeRadius=${policy.safeRadius}, intervalo=${policy.sweepIntervalMs}ms, modo=${policy.mode}.`
  );

  _sweepTimer = setInterval(() => {
    try {
      const r = sweepOnce(policy);
      if (r.removidos > 0 || r.protegidosPorDistancia > 0) {
        console.log(
          `[npc-cleaner] Varredura: ${r.removidos} desativado(s), ` +
          `${r.protegidosPorDistancia} preservado(s) por proximidade de jogador, ${r.avaliados} avaliado(s).`
        );
      }
    } catch (err) {
      console.error('[npc-cleaner] Erro na varredura:', err.message);
    }
  }, policy.sweepIntervalMs);

  if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
  return true;
}

function stopWorldCleaner() {
  if (!_sweepTimer) return false;
  clearInterval(_sweepTimer);
  _sweepTimer = null;
  return true;
}

function isWorldCleanerRunning() {
  return Boolean(_sweepTimer);
}

module.exports = {
  startWorldCleaner,
  stopWorldCleaner,
  isWorldCleanerRunning,
  loadPolicy,
  sweepOnce,
  // Exposto pra teste: a regra de remocao permanente merece teste direto.
  _shouldRemove
};
