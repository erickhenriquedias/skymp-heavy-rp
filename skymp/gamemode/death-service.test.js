/**
 * death-service.test.js
 *
 * Testes do fluxo de morte com consequência real: DOWNED → socorro OU
 * bleed-out (penalidade + contexto de morte pra staff) → respawn.
 *
 * Executa com: node --test death-service.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Mock do banco de dados (compartilhado por death-service e core/transaction-service,
// que também é carregado através do mesmo Module._load abaixo)
// ─────────────────────────────────────────────────────────────────────────────

let mockGold = {}; // characterId -> gold
const auditEntries = [];
const goldLedger = [];

function makeConn() {
  return {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params = []) => {
      if (/SELECT gold FROM characters/i.test(sql)) {
        return [[{ gold: mockGold[params[0]] || 0 }]];
      }
      if (/UPDATE characters SET gold = gold \+/i.test(sql)) {
        mockGold[params[1]] = (mockGold[params[1]] || 0) + params[0];
        return [[{}]];
      }
      if (/INSERT INTO gold_transactions/i.test(sql)) {
        goldLedger.push(params);
        return [[{}]];
      }
      return [[]];
    }
  };
}

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database' || request === '../database') {
    return {
      query: async (sql, params = []) => {
        if (/SELECT gold FROM characters/i.test(sql)) {
          return [{ gold: mockGold[params[0]] || 0 }];
        }
        if (/INSERT INTO audit_logs/i.test(sql)) {
          auditEntries.push(params);
          return [{}];
        }
        return [];
      },
      getConnection: async () => makeConn(),
      init: () => {}
    };
  }
  return originalLoad.apply(this, arguments);
};

// Mock mínimo do runtime `mp` — só o suficiente pra executeRespawn/rescueTarget rodarem.
const mpState = { values: new Map() };

/**
 * Emula `LocationalDataBinding::Set` do addon nativo.
 *
 * **[DOC]** (`SKYMP_UPSTREAM_REFERENCE.md` §8.4) a escrita exige os três campos
 * `cellOrWorldDesc` (string), `pos` (array) e `rot` (array), lidos por
 * `NapiHelper::ExtractString` / `ExtractNiPoint3` — que **lançam** quando o tipo
 * não bate (`NapiHelper.h:96,218`).
 *
 * ─── Por que o mock precisa ser rigoroso aqui ────────────────────────────────
 *
 * Enquanto ele apenas guardava o que recebesse, o `executeRespawn` podia mandar
 * `{ pos, worldOrCell, angleZ }` — que o servidor real rejeita — e todo teste
 * deste arquivo continuava verde. É literalmente o ponto de abertura da
 * `REVISAO_REALIDADE_COMPARTILHADA.md`: *"um mock aceita qualquer payload; o
 * addon nativo não"*. Um mock permissivo não é neutro, é cobertura falsa.
 *
 * Com esta checagem, reverter o payload do `executeRespawn` para a forma antiga
 * (mutação aplicada e executada) reprova **dois** testes — e o que importa é o
 * segundo deles, "volta o personagem pra NORMAL", que não é sobre posição
 * nenhuma. Ele reprova porque o `mp.set` lança antes e derruba as linhas
 * seguintes junto, que é exatamente o efeito real do defeito em produção.
 */
function assertLocationalData(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('ExtractObject: locationalData nao e objeto');
  }
  if (typeof value.cellOrWorldDesc !== 'string') {
    throw new Error(
      `ExtractString: 'cellOrWorldDesc' esperava string, veio ${typeof value.cellOrWorldDesc}. ` +
      `Campos recebidos: ${Object.keys(value).join(', ')}`
    );
  }
  for (const campo of ['pos', 'rot']) {
    if (!Array.isArray(value[campo]) || value[campo].length !== 3) {
      throw new Error(`ExtractNiPoint3: '${campo}' esperava array de 3 numeros`);
    }
  }
}

global.mp = {
  get: (actorId, prop) => mpState.values.get(`${actorId}:${prop}`) ?? null,
  set: (actorId, prop, value) => {
    if (prop === 'locationalData') assertLocationalData(value);
    mpState.values.set(`${actorId}:${prop}`, value);
  },
  getDescFromId: (actorId) => `desc-${actorId}`,
  getActorsByProfileId: () => [],
  callPapyrusFunction: () => null
};

function setPos(actorId, pos, cell = 'whiterun') {
  mpState.values.set(`${actorId}:locationalData`, { pos, cellOrWorldDesc: cell });
  mpState.values.set(`${actorId}:type`, 'MpActor');
}

function setNeighbors(actorId, neighborIds) {
  mpState.values.set(`${actorId}:neighbors`, neighborIds);
}

const commands = require('./commands');
const characterState = require('./core/character-state');
const { STATES } = characterState;
const deathService = require('./death-service');
const deathEvents = require('./core/death-events');

Module._load = originalLoad;

after(() => {
  deathService.shutdownDeathService();
  delete global.mp;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VICTIM_ACTOR_ID = 0xff00d001;
const VICTIM_CHARACTER_ID = 8001;
const RESCUER_ACTOR_ID = 0xff00d002;
const RESCUER_CHARACTER_ID = 8002;

describe('death-service — lifecycle', () => {
  it('shutdown remove assinatura, estado e permite reinicializar sem duplicar recursos', async () => {
    deathService.shutdownDeathService();
    deathService.initDeathService();
    assert.ok(deathEvents.subscriberNames().includes('death-service'));

    commands.registerActiveCharacter(
      VICTIM_ACTOR_ID,
      { id: VICTIM_CHARACTER_ID, first_name: 'Vitima', last_name: 'Um' },
      1,
      1
    );
    characterState.set(VICTIM_CHARACTER_ID, STATES.NORMAL, {});
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
    assert.strictEqual(deathService._downedPlayers.size, 1);

    deathService.shutdownDeathService();
    assert.ok(!deathEvents.subscriberNames().includes('death-service'));
    assert.strictEqual(deathService._downedPlayers.size, 0);
    assert.strictEqual(deathService._lastHealth.size, 0);
    assert.strictEqual(deathService._killers.size, 0);

    deathService.initDeathService();
    assert.deepStrictEqual(
      deathEvents.subscriberNames().filter(name => name === 'death-service'),
      ['death-service']
    );
    deathService.shutdownDeathService();
  });
});

describe('death-service', () => {
  beforeEach(() => {
    commands.registerActiveCharacter(VICTIM_ACTOR_ID, { id: VICTIM_CHARACTER_ID, first_name: 'Vitima', last_name: 'Um' }, 1, 1);
    commands.registerActiveCharacter(RESCUER_ACTOR_ID, { id: RESCUER_CHARACTER_ID, first_name: 'Socorrista', last_name: 'Dois' }, 2, 2);
    characterState.set(VICTIM_CHARACTER_ID, STATES.NORMAL, {});
    characterState.set(RESCUER_CHARACTER_ID, STATES.NORMAL, {});
    setPos(VICTIM_ACTOR_ID, [0, 0, 0]);
    setPos(RESCUER_ACTOR_ID, [10, 0, 0]);
    setNeighbors(VICTIM_ACTOR_ID, [RESCUER_ACTOR_ID]);
    mockGold = { [VICTIM_CHARACTER_ID]: 500 };
    auditEntries.length = 0;
    goldLedger.length = 0;
    deathService._downedPlayers.clear();
  });

  it('handlePlayerDowned coloca o personagem em DOWNED', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
    assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.DOWNED);
    assert.strictEqual(deathService.isDowned(VICTIM_CHARACTER_ID), true);
  });

  it('handlePlayerDowned ignora quedas repetidas do mesmo personagem já DOWNED', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
    const firstEntry = deathService._downedPlayers.get(VICTIM_CHARACTER_ID);
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
    const secondEntry = deathService._downedPlayers.get(VICTIM_CHARACTER_ID);
    assert.strictEqual(firstEntry, secondEntry, 'não deveria recriar o timer de bleed-out');
  });

  describe('rescueTarget', () => {
    it('estabiliza o alvo DOWNED dentro de alcance e cancela o bleed-out', async () => {
      await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
      await deathService.rescueTarget(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID);

      assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.NORMAL);
      assert.strictEqual(deathService.isDowned(VICTIM_CHARACTER_ID), false);
    });

    it('não faz nada se o alvo não está DOWNED', async () => {
      await deathService.rescueTarget(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID);
      assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.NORMAL);
    });

    it('bloqueia socorro fora de alcance', async () => {
      await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
      setPos(RESCUER_ACTOR_ID, [50000, 0, 0]);

      await deathService.rescueTarget(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID);

      assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.DOWNED, 'socorro fora de alcance não deveria estabilizar');
      assert.strictEqual(deathService.isDowned(VICTIM_CHARACTER_ID), true);
    });

    it('impede socorrer a si mesmo', async () => {
      await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
      await deathService.rescueTarget(VICTIM_ACTOR_ID, VICTIM_ACTOR_ID);
      assert.strictEqual(deathService.isDowned(VICTIM_CHARACTER_ID), true);
    });
  });

  describe('bleedOut', () => {
    it('aplica a penalidade de morte, registra contexto e transiciona pra DEAD', async () => {
      await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
      const penalty = await deathService.bleedOut(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID);

      assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.DEAD);
      assert.ok(penalty > 0, 'deveria ter aplicado alguma penalidade');
      assert.strictEqual(mockGold[VICTIM_CHARACTER_ID], 500 - penalty);
      assert.strictEqual(deathService.isDowned(VICTIM_CHARACTER_ID), false);

      const contextEntry = auditEntries.find(p => p[0] === 'death:context');
      assert.ok(contextEntry, 'deveria ter registrado o contexto de morte em audit_logs');
      const details = JSON.parse(contextEntry[3]);
      assert.strictEqual(details.characterId, VICTIM_CHARACTER_ID);
      assert.strictEqual(details.cause, 'bleed_out');
      assert.ok(details.nearby.some(n => n.characterId === RESCUER_CHARACTER_ID), 'socorrista próximo deveria aparecer no contexto');
    });

    it('penalidade nunca deixa o saldo negativo (usa min(gold, penalidade))', async () => {
      mockGold[VICTIM_CHARACTER_ID] = 10; // menor que DEATH_PENALTY_COINS (50)
      const penalty = await deathService.bleedOut(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID);
      assert.strictEqual(penalty, 10);
      assert.strictEqual(mockGold[VICTIM_CHARACTER_ID], 0);
    });
  });

  describe('executeRespawn', () => {
    it('volta o personagem pra NORMAL após a penalidade', async () => {
      characterState.set(VICTIM_CHARACTER_ID, STATES.DEAD, {});
      await deathService.executeRespawn(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID, 50);
      assert.strictEqual(characterState.get(VICTIM_CHARACTER_ID), STATES.NORMAL);
    });

    // ── O achado B da REVISAO_REALIDADE_COMPARTILHADA.md §6.3 ────────────────
    //
    // O payload era `{ pos, worldOrCell, angleZ }`. Nenhum desses três nomes
    // existe no binding nativo: `cellOrWorldDesc` vinha `undefined`, que não é
    // string, e o `mp.set` lançava — derrubando `_wasDead`, `characterState`,
    // a notificação e o refresh do painel junto, tudo engolido pelo `catch`
    // como um "Failed to respawn actor" genérico.

    it('escreve locationalData na forma que o addon nativo aceita', async () => {
      mpState.values.delete(`${VICTIM_ACTOR_ID}:locationalData`);
      await deathService.executeRespawn(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID, 0);

      const loc = mpState.values.get(`${VICTIM_ACTOR_ID}:locationalData`);
      assert.ok(loc, 'o respawn precisa ter escrito locationalData — se lancou, nao escreveu');
      assert.deepStrictEqual(
        Object.keys(loc).sort(), ['cellOrWorldDesc', 'pos', 'rot'],
        'os tres nomes sao exigencia do LocationalDataBinding, nao convencao nossa'
      );
      assert.strictEqual(typeof loc.cellOrWorldDesc, 'string');
      assert.strictEqual(loc.rot.length, 3);
      assert.strictEqual(loc.pos.length, 3);
    });

    it('a celula de respawn e um FormDesc, nao hexadecimal com 0x', () => {
      const desc = deathService._respawnCellDesc();
      assert.strictEqual(typeof desc, 'string');
      assert.ok(
        !/^0x/i.test(desc),
        `'${desc}' comeca com 0x — FormDesc::FromString nao valida isso, so resolve para ` +
        `outra faixa de FormID em silencio (§8.5)`
      );
    });

    it('o fallback da celula esta no formato FormDesc', () => {
      // O caminho derivado depende de `mp.getDescFromId`; o literal é a rede,
      // e uma rede no formato errado não é rede.
      const safeZones = require('./core/safe-zones');
      assert.strictEqual(
        safeZones.motivoDeCellIdInvalido(deathService.RESPAWN_CELL_FALLBACK), null,
        `RESPAWN_CELL_FALLBACK invalido: ${deathService.RESPAWN_CELL_FALLBACK}`
      );
    });

    it('deriva a celula por mp.getDescFromId quando disponivel', () => {
      // Derivar sobrevive a mudança de load order; o literal não.
      assert.strictEqual(
        deathService._respawnCellDesc(), 'desc-90850',
        'o mock devolve `desc-<id>`; se vier o literal, a derivacao nao esta acontecendo'
      );
    });

    it('cai no literal quando mp.getDescFromId nao existe', () => {
      const real = global.mp.getDescFromId;
      delete global.mp.getDescFromId;
      try {
        assert.strictEqual(
          deathService._respawnCellDesc(), deathService.RESPAWN_CELL_FALLBACK,
          'o market-stalls-service ja trata getDescFromId como possivelmente ausente'
        );
      } finally {
        global.mp.getDescFromId = real;
      }
    });
  });

  describe('logCombatInitiation (/iniciar)', () => {
    it('registra o início do conflito em audit_logs quando dentro de alcance', async () => {
      await deathService.logCombatInitiation(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID, 'assalto na estrada');

      const entry = auditEntries.find(p => p[0] === 'combat:initiate');
      assert.ok(entry, 'deveria ter registrado combat:initiate');
      const details = JSON.parse(entry[3]);
      assert.strictEqual(details.initiatorCharacterId, RESCUER_CHARACTER_ID);
      assert.strictEqual(details.targetCharacterId, VICTIM_CHARACTER_ID);
      assert.strictEqual(details.reason, 'assalto na estrada');
    });

    it('bloqueia sem motivo', async () => {
      auditEntries.length = 0;
      await deathService.logCombatInitiation(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID, '');
      assert.strictEqual(auditEntries.find(p => p[0] === 'combat:initiate'), undefined);
    });

    it('bloqueia fora de alcance', async () => {
      auditEntries.length = 0;
      setPos(RESCUER_ACTOR_ID, [50000, 0, 0]);
      await deathService.logCombatInitiation(RESCUER_ACTOR_ID, VICTIM_ACTOR_ID, 'motivo qualquer');
      assert.strictEqual(auditEntries.find(p => p[0] === 'combat:initiate'), undefined);
    });

    it('bloqueia iniciar contra si mesmo', async () => {
      auditEntries.length = 0;
      await deathService.logCombatInitiation(VICTIM_ACTOR_ID, VICTIM_ACTOR_ID, 'motivo qualquer');
      assert.strictEqual(auditEntries.find(p => p[0] === 'combat:initiate'), undefined);
    });
  });

  describe('checkDamageSpike', () => {
    beforeEach(() => {
      deathService._lastHealth.clear();
    });

    it('registra death:context com cause=damage_spike numa queda brusca de vida', () => {
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100); // baseline
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 50);  // queda de 50 (>= threshold de 25)

      const entry = auditEntries.find(p => p[0] === 'death:context');
      assert.ok(entry, 'deveria ter registrado contexto de dano');
      const details = JSON.parse(entry[3]);
      assert.strictEqual(details.cause, 'damage_spike');
    });

    it('não registra nada pra quedas pequenas de vida', () => {
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100);
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 90); // queda de 10, abaixo do threshold
      assert.strictEqual(auditEntries.find(p => p[0] === 'death:context'), undefined);
    });

    it('não registra nada quando a vida chega a 0 (é morte, não dano)', () => {
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100);
      deathService.checkDamageSpike(VICTIM_ACTOR_ID, 0);
      assert.strictEqual(auditEntries.find(p => p[0] === 'death:context'), undefined);
    });

    /**
     * O actorId é um slot que o SkyMP reaproveita entre sessões — a mesma coisa
     * que fazia o cargo de staff ficar preso ao slot (ver commands.js). Aqui o
     * estrago é uma evidência falsa de RDM: quem entra herdaria a última
     * leitura de vida de quem saiu.
     *
     * Os dois testes abaixo são o par de mutação: se `cleanup()` deixar de
     * apagar a entrada, o primeiro passa a gravar um `damage_spike` que
     * ninguém causou e o segundo passa a esconder uma agressão real.
     */
    describe('desconexão limpa a última leitura de vida', () => {
      const NOVO_OCUPANTE_CHARACTER_ID = 8009;

      it('quem entra no actorId de quem saiu ferido não gera damage_spike falso', () => {
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 500);

        // Jogador sai. É o que `commands.removeActiveCharacter` chama.
        deathService.cleanup(VICTIM_ACTOR_ID);

        // Slot reaproveitado por outra pessoa, que entra com 100 de vida.
        commands.registerActiveCharacter(
          VICTIM_ACTOR_ID,
          { id: NOVO_OCUPANTE_CHARACTER_ID, first_name: 'Recem', last_name: 'Chegado' }, 9, 9
        );
        characterState.set(NOVO_OCUPANTE_CHARACTER_ID, STATES.NORMAL, {});
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100);

        assert.strictEqual(
          auditEntries.find(p => p[0] === 'death:context'), undefined,
          'a queda de 500 pra 100 é troca de jogador, não dano — não pode virar evidência'
        );
      });

      it('sem a limpeza, a leitura antiga também mascararia uma agressão real', () => {
        // Prova o outro lado: entrada obsoleta BAIXA (saiu ferido) faz a
        // primeira leitura do novo jogador parecer cura, e o golpe seguinte
        // ser medido contra o baseline errado.
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 20);
        deathService.cleanup(VICTIM_ACTOR_ID);

        // Novo ocupante entra cheio e leva 60 de dano no tick seguinte.
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100);
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 40);

        const entry = auditEntries.find(p => p[0] === 'death:context');
        assert.ok(entry, 'a agressão real depois da troca de slot precisa ser registrada');
        assert.strictEqual(JSON.parse(entry[3]).cause, 'damage_spike');
      });

      it('cleanup só apaga o actorId pedido', () => {
        deathService.checkDamageSpike(VICTIM_ACTOR_ID, 100);
        deathService.checkDamageSpike(RESCUER_ACTOR_ID, 100);

        deathService.cleanup(VICTIM_ACTOR_ID);

        assert.strictEqual(deathService._lastHealth.has(VICTIM_ACTOR_ID), false);
        assert.strictEqual(
          deathService._lastHealth.get(RESCUER_ACTOR_ID), 100,
          'a desconexão de um jogador não pode zerar o baseline dos outros'
        );
      });
    });
  });
});

/**
 * A limpeza precisa estar ligada no caminho de desconexão, não só existir.
 *
 * `phase0-basic.js` chama `commands.removeActiveCharacter(actorId)` quando o
 * polling detecta `connected === false`; é ali que toda memória por actorId
 * morre. Um `cleanup()` exportado e nunca chamado seria o mesmo tipo de defeito
 * que o `.env` que ninguém carregava: existe, tem teste, e não roda em jogo.
 */
describe('death-service — desconexão pelo caminho real (removeActiveCharacter)', () => {
  const SAINDO_ACTOR_ID = 0xff00d00a;
  const SAINDO_CHARACTER_ID = 8010;

  it('removeActiveCharacter apaga a última leitura de vida do slot', () => {
    commands.registerActiveCharacter(
      SAINDO_ACTOR_ID,
      { id: SAINDO_CHARACTER_ID, first_name: 'Vai', last_name: 'Embora' }, 10, 10
    );
    deathService.checkDamageSpike(SAINDO_ACTOR_ID, 480);
    assert.strictEqual(deathService._lastHealth.has(SAINDO_ACTOR_ID), true);

    commands.removeActiveCharacter(SAINDO_ACTOR_ID);

    assert.strictEqual(
      deathService._lastHealth.has(SAINDO_ACTOR_ID), false,
      'o caminho de desconexão precisa chamar death-service.cleanup()'
    );
  });
});

/**
 * Atribuição de morte via `mp.onDeath`.
 *
 * A diferença entre evidência e atribuição: `logDeathContext` lista quem estava
 * por perto — numa briga de cinco pessoas, cinco nomes, e a staff decide no
 * olho. `mp.onDeath` entrega `killerId`, que é o servidor dizendo quem foi.
 *
 * Fonte do hook: `misc/tests/test_isdead.js` do repositório upstream.
 */
describe('death-service — autoria da morte (mp.onDeath)', () => {
  const KILLER_ACTOR_ID = 0xff00d003;
  const KILLER_CHARACTER_ID = 8003;

  beforeEach(() => {
    commands.registerActiveCharacter(VICTIM_ACTOR_ID, { id: VICTIM_CHARACTER_ID, first_name: 'Vitima', last_name: 'Um' }, 1, 1);
    commands.registerActiveCharacter(KILLER_ACTOR_ID, { id: KILLER_CHARACTER_ID, first_name: 'Agressor', last_name: 'Tres' }, 3, 3);
    characterState.set(VICTIM_CHARACTER_ID, STATES.NORMAL, {});
    setPos(VICTIM_ACTOR_ID, [0, 0, 0]);
    auditEntries.length = 0;
    deathService._downedPlayers.clear();
    deathService._killers.clear();
  });

  it('registra quem matou quando o hook informa o killerId', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, KILLER_ACTOR_ID);

    const entry = auditEntries.find(p => p[0] === 'death:killer');
    assert.ok(entry, 'deveria ter gravado death:killer em audit_logs');

    const details = JSON.parse(entry[3]);
    assert.strictEqual(details.characterId, VICTIM_CHARACTER_ID);
    assert.strictEqual(details.killer.characterId, KILLER_CHARACTER_ID);
    assert.strictEqual(details.killer.name, 'Agressor Tres');
  });

  it('não grava autoria quando killerId é 0 (queda, veneno)', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, 0);
    assert.strictEqual(auditEntries.find(p => p[0] === 'death:killer'), undefined);
  });

  it('não grava autoria quando a queda veio pelo polling (sem killerId)', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID);
    assert.strictEqual(auditEntries.find(p => p[0] === 'death:killer'), undefined);
  });

  it('agressor sem personagem carregado é registrado como NPC/ator do mundo', async () => {
    // Morte por NPC não é RDM — distinguir isso já é informação pra staff.
    const NPC_ACTOR_ID = 0x000abcde;
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, NPC_ACTOR_ID);

    const details = JSON.parse(auditEntries.find(p => p[0] === 'death:killer')[3]);
    assert.strictEqual(details.killer.actorId, NPC_ACTOR_ID);
    assert.strictEqual(details.killer.characterId, null);
    assert.strictEqual(details.killer.name, null);
  });

  it('a autoria sobrevive até o bleed-out, minutos depois', async () => {
    // O killerId só existe no instante da queda; o bleed-out acontece até 4
    // minutos depois e precisa gravá-lo no contexto final.
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, KILLER_ACTOR_ID);
    auditEntries.length = 0;

    await deathService.bleedOut(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID);

    const contextEntry = auditEntries.find(p => p[0] === 'death:context');
    assert.ok(contextEntry, 'bleed-out deveria gravar death:context');
    const details = JSON.parse(contextEntry[3]);
    assert.ok(details.killer, 'o contexto final precisa carregar a autoria');
    assert.strictEqual(details.killer.characterId, KILLER_CHARACTER_ID);
  });

  it('socorro a tempo limpa a autoria (não houve morte)', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, KILLER_ACTOR_ID);
    assert.ok(deathService._killers.has(VICTIM_CHARACTER_ID));

    setPos(KILLER_ACTOR_ID, [10, 0, 0]);
    await deathService.rescueTarget(KILLER_ACTOR_ID, VICTIM_ACTOR_ID);

    assert.strictEqual(deathService._killers.has(VICTIM_CHARACTER_ID), false,
      'sem morte, a autoria não precisa continuar em memória');
  });

  it('bleed-out limpa a autoria (senão vaza memória a cada morte)', async () => {
    await deathService._handlePlayerDowned(VICTIM_ACTOR_ID, KILLER_ACTOR_ID);
    await deathService.bleedOut(VICTIM_ACTOR_ID, VICTIM_CHARACTER_ID);
    assert.strictEqual(deathService._killers.has(VICTIM_CHARACTER_ID), false);
  });
});
