/**
 * npc-cleaner.test.js
 *
 * O servico nao tinha teste nenhum — e e o unico do gamemode que remove coisa
 * do mundo de forma que o jogador nao pode desfazer. A versao anterior apagava
 * (`disable` + `delete`) todo ator de `profileId 0` a cada 60s, com a allowlist
 * vazia e o `safeRadius` declarado e nunca lido.
 *
 * Estes testes existem pra travar as tres inversoes: lista de bloqueio (nao de
 * permissao), safeRadius de verdade, e nada irreversivel.
 *
 * Executa com: node --test npc-cleaner.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

const NPC_LONGE = 0x000a0001;
const NPC_PERTO = 0x000a0002;
const NPC_INOCENTE = 0x000a0003;
const JOGADOR = 0xff000001;

const BASE_BLOQUEADO = '1a6a0:Skyrim.esm';
const BASE_INOCENTE = 'bebete:Skyrim.esm';

const chamadasPapyrus = [];
const posicoes = new Map();
const basePorAtor = new Map();

const originalMp = global.mp;

global.mp = {
  getDescFromId: (formId) => `${formId.toString(16)}:Skyrim.esm`,
  getActorsByProfileId: (profileId) => {
    if (profileId === 0) return [NPC_LONGE, NPC_PERTO, NPC_INOCENTE];
    if (profileId === 1) return [JOGADOR];
    return [];
  },
  get: (actorId, prop) => {
    if (prop === 'baseDesc') return basePorAtor.get(actorId) || null;
    if (prop === 'locationalData') return posicoes.get(actorId) || null;
    if (prop === 'type') return 'MpActor';
    return null;
  },
  callPapyrusFunction: (callType, className, fnName, self, args) => {
    chamadasPapyrus.push({ callType, className, fnName, self, args });
    return null;
  }
};

const npcCleaner = require('./npc-cleaner');

after(() => {
  npcCleaner.stopWorldCleaner();
  if (originalMp === undefined) delete global.mp;
  else global.mp = originalMp;
});

const CELULA = '0x162e2';
const emCelula = (x) => ({ pos: [x, 0, 0], cellOrWorldDesc: CELULA });

beforeEach(() => {
  chamadasPapyrus.length = 0;
  posicoes.clear();
  basePorAtor.clear();

  posicoes.set(JOGADOR, emCelula(0));
  posicoes.set(NPC_LONGE, emCelula(9000));    // bem fora do safeRadius
  posicoes.set(NPC_PERTO, emCelula(100));     // colado no jogador
  posicoes.set(NPC_INOCENTE, emCelula(9000));

  basePorAtor.set(NPC_LONGE, BASE_BLOQUEADO);
  basePorAtor.set(NPC_PERTO, BASE_BLOQUEADO);
  basePorAtor.set(NPC_INOCENTE, BASE_INOCENTE);
});

function policy(extra = {}) {
  return {
    enabled: true,
    blockedBaseDescs: new Set([BASE_BLOQUEADO]),
    safeRadius: 5000,
    sweepIntervalMs: 60000,
    mode: 'disable',
    ...extra
  };
}

describe('npc-cleaner — a lista e de bloqueio, nao de permissao', () => {
  it('lista vazia nao remove NADA (o bug antigo removia o mundo inteiro)', () => {
    const r = npcCleaner.sweepOnce(policy({ blockedBaseDescs: new Set() }));

    assert.strictEqual(r.removidos, 0);
    assert.strictEqual(
      chamadasPapyrus.length, 0,
      'com a lista vazia nem deveria varrer — a versao anterior apagava todo ator de profileId 0 aqui'
    );
  });

  it('remove apenas o record listado, nunca os vizinhos', () => {
    const r = npcCleaner.sweepOnce(policy());

    assert.strictEqual(r.removidos, 1, 'so o NPC bloqueado e longe deveria sair');
    const alvos = chamadasPapyrus.map(c => c.self.desc);
    assert.ok(
      alvos.includes(global.mp.getDescFromId(NPC_LONGE)),
      'o NPC bloqueado e distante deveria ter sido desativado'
    );
    assert.ok(
      !alvos.includes(global.mp.getDescFromId(NPC_INOCENTE)),
      'NPC fora da lista foi tocado — e a regressao que este arquivo existe pra impedir'
    );
  });
});

describe('npc-cleaner — safeRadius protege quem esta na frente do jogador', () => {
  it('NPC bloqueado perto de um jogador nao e tocado', () => {
    const r = npcCleaner.sweepOnce(policy());

    const alvos = chamadasPapyrus.map(c => c.self.desc);
    assert.ok(
      !alvos.includes(global.mp.getDescFromId(NPC_PERTO)),
      'ator sumindo na frente do jogador e exatamente o que o safeRadius existe pra evitar'
    );
    assert.strictEqual(r.protegidosPorDistancia, 1);
  });

  it('o mesmo NPC sai quando ninguem esta por perto', () => {
    posicoes.set(JOGADOR, emCelula(99999));

    const r = npcCleaner.sweepOnce(policy());

    assert.strictEqual(r.removidos, 2, 'sem jogador por perto, os dois bloqueados saem');
  });

  it('_shouldRemove respeita a fronteira do raio', () => {
    const p = policy({ safeRadius: 1000 });

    assert.strictEqual(npcCleaner._shouldRemove(BASE_BLOQUEADO, 1500, p), true, 'fora do raio: pode');
    assert.strictEqual(npcCleaner._shouldRemove(BASE_BLOQUEADO, 1000, p), false, 'exatamente no raio: protegido');
    assert.strictEqual(npcCleaner._shouldRemove(BASE_BLOQUEADO, 500, p), false, 'dentro do raio: protegido');
    assert.strictEqual(npcCleaner._shouldRemove(BASE_INOCENTE, 99999, p), false, 'fora da lista: nunca');
    assert.strictEqual(npcCleaner._shouldRemove(null, 99999, p), false, 'sem baseDesc: nunca');
  });
});

describe('npc-cleaner — nada irreversivel', () => {
  it('usa disable e nunca delete', () => {
    posicoes.set(JOGADOR, emCelula(99999));
    npcCleaner.sweepOnce(policy());

    const funcoes = chamadasPapyrus.map(c => c.fnName);
    assert.ok(funcoes.includes('disable'), 'deveria desativar');
    assert.ok(
      !funcoes.includes('delete'),
      'delete numa referencia persistente nao volta — a decisao de MVP e Spawn Seletivo, nao terra arrasada'
    );
  });

  it('manda o self no formato de objeto, nunca o FormID cru', () => {
    posicoes.set(JOGADOR, emCelula(99999));
    npcCleaner.sweepOnce(policy());

    for (const chamada of chamadasPapyrus) {
      assert.strictEqual(typeof chamada.self, 'object', 'self precisa ser objeto (QA 2.13)');
      assert.strictEqual(chamada.self.type, 'form');
    }
  });
});

describe('npc-cleaner — config invalida nao vira remocao', () => {
  it('safeRadius NaN cai no default em vez de proteger ninguem', () => {
    // NaN em toda comparacao da false, entao `distancia > NaN` seria false e
    // nada sairia — mas o caminho oposto (um raio 0 acidental) removeria tudo
    // que estivesse na lista, sem margem. O default e o unico valor honesto.
    const p = { ...policy(), safeRadius: Number.NaN };
    assert.strictEqual(npcCleaner._shouldRemove(BASE_BLOQUEADO, 99999, p), false);
  });
});

describe('npc-cleaner — lifecycle', () => {
  it('nao cria intervalos duplicados e pode reiniciar depois do shutdown', () => {
    assert.strictEqual(npcCleaner.startWorldCleaner(policy()), true);
    assert.strictEqual(npcCleaner.isWorldCleanerRunning(), true);
    assert.strictEqual(
      npcCleaner.startWorldCleaner(policy()), false,
      'uma segunda inicializacao nao pode criar outro intervalo'
    );

    assert.strictEqual(npcCleaner.stopWorldCleaner(), true);
    assert.strictEqual(npcCleaner.isWorldCleanerRunning(), false);
    assert.strictEqual(npcCleaner.stopWorldCleaner(), false);

    assert.strictEqual(npcCleaner.startWorldCleaner(policy()), true);
    assert.strictEqual(npcCleaner.stopWorldCleaner(), true);
  });
});
