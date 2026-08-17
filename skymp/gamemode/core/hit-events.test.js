/**
 * core/hit-events.test.js
 *
 * O snippet de cliente **não pode ser testado aqui** — ele roda dentro do
 * Skyrim Platform, na máquina do jogador, e só existe quando alguém conecta.
 * Isso é a Fase 0.
 *
 * O que dá pra testar, e é onde mora a regra, é o que o servidor faz com o
 * evento depois que ele chega: a normalização do `0x14`, a agregação em
 * episódio e o fechamento por silêncio. Todos recebem o relógio por argumento
 * justamente para isso.
 *
 * Executa com: node --test core/hit-events.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

const hitEvents = require('./hit-events');

const A = 0xff000001; // agressor
const B = 0xff000002; // alvo
const C = 0xff000003;
const JOGADOR_LOCAL = 0x14;

const T0 = 1_000_000;

function golpe(extra = {}) {
  return { aggressor: A, target: B, ...extra };
}

beforeEach(() => {
  hitEvents.stop();
});

after(() => hitEvents.stop());

describe('hit-events — o 0x14 do cliente vira o ator de verdade', () => {
  it('agressor 0x14 é trocado pelo pcFormId de quem mandou', () => {
    // Sem isso, todo golpe desferido pelo proprio jogador apontaria pro form
    // errado — foi o detalhe que o Red House deixou registrado.
    const ep = hitEvents.registrarGolpe(A, { aggressor: JOGADOR_LOCAL, target: B }, T0);
    assert.strictEqual(ep.agressor, A);
    assert.strictEqual(ep.alvo, B);
  });

  it('alvo 0x14 também é trocado', () => {
    const ep = hitEvents.registrarGolpe(B, { aggressor: A, target: JOGADOR_LOCAL }, T0);
    assert.strictEqual(ep.agressor, A);
    assert.strictEqual(ep.alvo, B);
  });

  it('golpe em si mesmo é descartado', () => {
    // Queda, veneno, o proprio feitico. Nao e agressao entre pessoas e nao
    // interessa a arbitragem de RDM.
    assert.strictEqual(hitEvents.registrarGolpe(A, { aggressor: A, target: A }, T0), null);
    assert.strictEqual(hitEvents.registrarGolpe(A, { aggressor: JOGADOR_LOCAL, target: A }, T0), null);
  });

  it('payload malformado não derruba nada', () => {
    assert.strictEqual(hitEvents.registrarGolpe(A, null, T0), null);
    assert.strictEqual(hitEvents.registrarGolpe(A, {}, T0), null);
    assert.strictEqual(hitEvents.registrarGolpe(A, { aggressor: 'x', target: 'y' }, T0), null);
  });
});

describe('hit-events — agrega em episódio, não grava golpe a golpe', () => {
  it('golpes seguidos entre o mesmo par viram um episódio só', () => {
    for (let i = 0; i < 7; i++) hitEvents.registrarGolpe(A, golpe(), T0 + i * 500);

    const abertos = [...hitEvents._episodios.values()];
    assert.strictEqual(abertos.length, 1, 'sete golpes, um episodio');
    assert.strictEqual(abertos[0].golpes, 7);
  });

  it('conta os tipos de golpe separadamente', () => {
    hitEvents.registrarGolpe(A, golpe({ isPowerAttack: true }), T0);
    hitEvents.registrarGolpe(A, golpe({ isPowerAttack: true }), T0 + 100);
    hitEvents.registrarGolpe(A, golpe({ isSneakAttack: true }), T0 + 200);
    hitEvents.registrarGolpe(A, golpe({ isBashAttack: true }), T0 + 300);
    hitEvents.registrarGolpe(A, golpe({ isHitBlocked: true }), T0 + 400);

    const ep = [...hitEvents._episodios.values()][0];
    assert.strictEqual(ep.golpes, 5);
    assert.strictEqual(ep.powerAttacks, 2);
    assert.strictEqual(ep.sneakAttacks, 1);
    assert.strictEqual(ep.bashAttacks, 1);
    assert.strictEqual(ep.bloqueados, 1);
  });

  it('pares diferentes são episódios diferentes', () => {
    hitEvents.registrarGolpe(A, { aggressor: A, target: B }, T0);
    hitEvents.registrarGolpe(A, { aggressor: A, target: C }, T0);
    assert.strictEqual(hitEvents._episodios.size, 2);
  });

  it('A→B e B→A são episódios distintos', () => {
    // Quem comecou importa numa denuncia; somar os dois lados perderia isso.
    hitEvents.registrarGolpe(A, { aggressor: A, target: B }, T0);
    hitEvents.registrarGolpe(B, { aggressor: B, target: A }, T0);
    assert.strictEqual(hitEvents._episodios.size, 2);
  });

  it('a contagem tem teto — o número exato deixa de importar', () => {
    const total = hitEvents.MAX_GOLPES_POR_EPISODIO + 50;
    for (let i = 0; i < total; i++) hitEvents.registrarGolpe(A, golpe(), T0 + i);

    const ep = [...hitEvents._episodios.values()][0];
    assert.strictEqual(ep.golpes, hitEvents.MAX_GOLPES_POR_EPISODIO);
  });
});

describe('hit-events — o episódio fecha por silêncio', () => {
  it('não fecha enquanto os golpes continuam', () => {
    hitEvents.registrarGolpe(A, golpe(), T0);
    const fechados = hitEvents.fecharEpisodiosVencidos(T0 + hitEvents.JANELA_MS - 1);
    assert.deepEqual(fechados, []);
    assert.strictEqual(hitEvents._episodios.size, 1);
  });

  it('fecha depois da janela sem golpe novo, com duração', () => {
    hitEvents.registrarGolpe(A, golpe(), T0);
    hitEvents.registrarGolpe(A, golpe(), T0 + 12_000);

    const fechados = hitEvents.fecharEpisodiosVencidos(T0 + 12_000 + hitEvents.JANELA_MS);

    assert.strictEqual(fechados.length, 1);
    assert.strictEqual(fechados[0].golpes, 2);
    assert.strictEqual(fechados[0].duracaoMs, 12_000, 'do primeiro ao ultimo golpe');
    assert.strictEqual(hitEvents._episodios.size, 0, 'episodio fechado sai da memoria');
  });

  it('golpe novo dentro da janela estende o episódio', () => {
    hitEvents.registrarGolpe(A, golpe(), T0);
    hitEvents.fecharEpisodiosVencidos(T0 + 5_000);          // ainda vivo
    hitEvents.registrarGolpe(A, golpe(), T0 + 9_000);       // renova
    hitEvents.fecharEpisodiosVencidos(T0 + 12_000);         // 3s desde o ultimo

    assert.strictEqual(hitEvents._episodios.size, 1, 'a briga continua');
  });

  it('entrega cada episódio fechado ao assinante', () => {
    const recebidos = [];
    hitEvents.start((ep) => recebidos.push(ep));

    hitEvents.registrarGolpe(A, golpe(), T0);
    hitEvents.fecharEpisodiosVencidos(T0 + hitEvents.JANELA_MS);

    assert.strictEqual(recebidos.length, 1);
    assert.strictEqual(recebidos[0].agressor, A);
    assert.strictEqual(recebidos[0].alvo, B);
  });

  it('assinante que lança não impede os outros episódios de fechar', () => {
    const recebidos = [];
    let primeiro = true;
    hitEvents.start(() => {
      if (primeiro) { primeiro = false; throw new Error('boom'); }
      recebidos.push(true);
    });

    hitEvents.registrarGolpe(A, { aggressor: A, target: B }, T0);
    hitEvents.registrarGolpe(A, { aggressor: A, target: C }, T0);

    const originalError = console.error;
    console.error = () => {};
    const fechados = hitEvents.fecharEpisodiosVencidos(T0 + hitEvents.JANELA_MS);
    console.error = originalError;

    assert.strictEqual(fechados.length, 2, 'os dois fecharam mesmo com um assinante quebrando');
    assert.strictEqual(recebidos.length, 1);
  });
});

describe('hit-events — o snippet de cliente', () => {
  it('normaliza o FormID pro formato do servidor', () => {
    // `ctx.getFormIdInServerFormat()` e obrigatorio: FormID de cliente e de
    // servidor sao espacos diferentes. Mandar o numero cru daria outro objeto.
    assert.match(hitEvents.SNIPPET_DO_CLIENTE, /getFormIdInServerFormat/);
  });

  it('não deixa erro do cliente escapar', () => {
    // Um throw ali roda na maquina do jogador e nao tem pra onde ir; derrubar
    // o snippet mataria o rastro de todos os golpes seguintes daquele jogador.
    assert.match(hitEvents.SNIPPET_DO_CLIENTE, /try\s*\{/);
    assert.match(hitEvents.SNIPPET_DO_CLIENTE, /catch/);
  });

  it('escuta o evento de hit do Skyrim Platform', () => {
    assert.match(hitEvents.SNIPPET_DO_CLIENTE, /ctx\.sp\.on\(\s*'hit'/);
    assert.match(hitEvents.SNIPPET_DO_CLIENTE, /ctx\.sendEvent/);
  });

  it('o nome do evento começa com underscore', () => {
    // Exigencia da documentacao oficial pro roteamento cliente->servidor.
    assert.match(hitEvents.NOME_DO_EVENTO, /^_/);
  });
});

describe('hit-events — start sem servidor não quebra', () => {
  it('sem mp, avisa e devolve false', () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    const ok = hitEvents.start(() => {});
    console.warn = originalWarn;

    assert.strictEqual(ok, false, 'sem makeEventSource nao ha o que registrar');
  });

  it('stop remove somente o handler que o modulo instalou', () => {
    const originalMp = global.mp;
    global.mp = { makeEventSource: () => {} };
    try {
      assert.equal(hitEvents.start(() => {}), true);
      const handler = global.mp[hitEvents.NOME_DO_EVENTO];
      assert.equal(typeof handler, 'function');
      hitEvents.stop();
      assert.equal(global.mp[hitEvents.NOME_DO_EVENTO], undefined);
    } finally {
      hitEvents.stop();
      if (originalMp === undefined) delete global.mp;
      else global.mp = originalMp;
    }
  });
});
