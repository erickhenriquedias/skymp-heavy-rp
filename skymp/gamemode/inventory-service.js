/**
 * inventory-service.js — projeção do inventário no cliente
 *
 * ⚠️ **Este arquivo não é o Inventory Framework.** Desde 13/08/2026, a API
 * central de movimentação de item é `core/inventory.js`, e a documentação dela
 * é `docs/framework/INVENTORY_FRAMEWORK.md`. O que sobrou aqui é a outra
 * metade do assunto: levar o que o banco sabe até a tela do jogador, e os três
 * atalhos históricos (`giveItem`/`removeItem`/`hasItem`) que continuam válidos
 * para o caso de **um dono só**.
 *
 * Qual usar:
 *
 *   - um dono muda (staff dá item, recompensa)      → daqui, ou transaction-service
 *   - **dois** donos (troca, baú, barraca, craft)   → `core/inventory.transfer`
 *
 * A projeção é absoluta para stacks conhecidos pelo MariaDB: lê a contagem
 * nativa e aplica somente o delta. Reconnect/restart, portanto, não soma de
 * novo os mesmos itens. BaseIds exclusivamente nativos são preservados por
 * compatibilidade com loot/quests vanilla, mas nunca são importados para o DB.
 *
 * Serviço de inventário com reconciliação para prevenir duplicatas.
 *
 * IMPORTANTE: Este serviço NÃO modifica o banco diretamente.
 * Toda mudança de item usa core/transaction-service para garantir
 * atomicidade e rastreabilidade no ledger.
 *
 * Reconciliação:
 * - No login, o servidor lê o snapshot do banco (character_inventory)
 * - Compara com o que foi entregue nessa sessão (flag em memória)
 * - Só chama AddItem para itens ainda não sincronizados
 * - Divergências são logadas para revisão manual
 */

const db = require('./database');
const transactionService = require('./core/transaction-service');
const { actorRef } = require('./core/papyrus');
const skympAdapter = require('./core/skymp-adapter');
const { planStackProjection } = require('./core/inventory-projection');

// Serializa projeções concorrentes do mesmo personagem sem lock global.
const _projectionChains = new Map();

/**
 * Sincroniza o inventário do banco de dados para o cliente.
 * Usa reconciliação para prevenir duplicatas em reconexões.
 *
 * @param {number} actorId
 * @param {number} characterId
 */
async function _syncInventoryToClient(actorId, characterId) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('actorId invalido para projecao');
  if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new Error('characterId invalido para projecao');

  try {
    const rows = await db.query(
      `SELECT managed.base_id, COALESCE(current_stack.count, 0) AS count
         FROM (
           SELECT base_id FROM character_inventory WHERE character_id = ?
           UNION
           SELECT base_id FROM inventory_transactions WHERE character_id = ?
         ) AS managed
         LEFT JOIN character_inventory AS current_stack
           ON current_stack.character_id = ? AND current_stack.base_id = managed.base_id
        ORDER BY managed.base_id`,
      [characterId, characterId, characterId]
    );

    if (typeof mp === 'undefined') {
      return { additions: 0, removals: 0, managedStacks: rows.length, nativeOnlyStacks: 0 };
    }

    const nativeInventory = mp.get(actorId, 'inventory');
    const plan = planStackProjection(rows, nativeInventory);

    // Remover antes de adicionar reduz risco de ultrapassar capacidade nativa.
    for (const operation of plan.removals) {
      skympAdapter.callPapyrus(
        'method', 'ObjectReference', 'RemoveItem', actorRef(actorId),
        [operation.baseId, operation.count, true, null]
      );
    }
    for (const operation of plan.additions) {
      skympAdapter.callPapyrus(
        'method', 'ObjectReference', 'AddItem', actorRef(actorId),
        [operation.baseId, operation.count, true]
      );
    }

    // O binding do SkyMP pode falhar/ignorar sem uma excecao util dependendo
    // do artefato. Relido do servidor, nao do client: readiness do personagem
    // so passa quando os baseIds gerenciados realmente convergiram.
    const verification = planStackProjection(rows, mp.get(actorId, 'inventory'));
    if (verification.additions.length > 0 || verification.removals.length > 0) {
      throw new Error(
        `projecao nao convergiu (${verification.additions.length} adicoes e ` +
        `${verification.removals.length} remocoes ainda pendentes)`
      );
    }

    const result = {
      additions: plan.additions.length,
      removals: plan.removals.length,
      managedStacks: plan.managedStacks,
      nativeOnlyStacks: plan.nativeOnlyStacks
    };
    console.log(
      `[inventory] Projecao char ${characterId}: +${result.additions}/-${result.removals} stacks, ` +
      `${result.managedStacks} gerenciados, ${result.nativeOnlyStacks} somente nativos preservados`
    );
    return result;

  } catch (err) {
    console.error(`[inventory] Erro ao projetar inventário do char ${characterId}:`, err.message);
    throw err;
  }
}

function syncInventoryToClient(actorId, characterId) {
  const previous = _projectionChains.get(characterId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => _syncInventoryToClient(actorId, characterId));
  _projectionChains.set(characterId, current);
  return current.finally(() => {
    if (_projectionChains.get(characterId) === current) _projectionChains.delete(characterId);
  });
}

/**
 * Concede um item ao personagem (usa transaction-service).
 * Wrapper de conveniência para código legado que chama inventory-service diretamente.
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function giveItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.giveItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Remove um item do personagem (usa transaction-service).
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} count
 * @param {string} [reason]
 * @param {string} [module]
 * @returns {Promise<boolean>}
 */
async function removeItem(actorId, characterId, baseId, count, reason = 'unknown', module = 'inventory') {
  return transactionService.removeItem({ actorId, characterId, baseId, count, reason, module });
}

/**
 * Verifica se o personagem possui quantidade suficiente de item.
 * Usa o banco como fonte de verdade.
 *
 * @param {number} characterId
 * @param {number} baseId
 * @param {number} [minCount]
 * @returns {Promise<boolean>}
 */
async function hasItem(characterId, baseId, minCount = 1) {
  return transactionService.hasItem(characterId, baseId, minCount);
}

module.exports = {
  syncInventoryToClient,
  giveItem,
  removeItem,
  hasItem
};
