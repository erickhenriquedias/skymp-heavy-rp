/**
 * parity.test.mjs
 *
 * Primeiros testes do launcher. Ele tinha **zero**, e é o programa que todo
 * jogador roda — e o único lugar onde o contrato de FormID é verificado antes
 * de alguém entrar.
 *
 * O que estes testes protegem, em uma frase: se a verificação de paridade
 * aprovar um cliente que não deveria, o jogador entra e **vê itens
 * diferentes dos que o servidor gravou**. Não há erro, não há log, não há
 * crash — há um baú que tem outra coisa dentro. É o pior formato de bug que
 * este projeto pode produzir.
 *
 * Executa com: node --test electron/parity.test.mjs
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  parsePluginsTxt,
  parsePluginHeader,
  compareMods,
  analyzePlugins,
  parseCccTxt,
  analyzeCreationClub
} from './parity.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Ajudantes: plugin sintético em vez de .esm de 300 MB
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monta um TES4 mínimo com os masters pedidos.
 * @param {string[]} masters
 * @param {{isMaster?: boolean, isLight?: boolean}} [flags]
 */
function fakePlugin(masters = [], { isMaster = false, isLight = false } = {}) {
  const campos = masters.map(nome => {
    const valor = Buffer.from(nome + String.fromCharCode(0), 'utf8');
    const campo = Buffer.alloc(6 + valor.length);
    campo.write('MAST', 0, 'latin1');
    campo.writeUInt16LE(valor.length, 4);
    valor.copy(campo, 6);
    return campo;
  });

  const data = Buffer.concat(campos);
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  head.writeUInt32LE((isMaster ? 0x1 : 0) | (isLight ? 0x200 : 0), 8);

  return Buffer.concat([head, data]);
}

/** readHeader que devolve sempre um plugin sem masters. */
const semMasters = () => ({ masters: [], isMaster: false, isLight: false });

// ─────────────────────────────────────────────────────────────────────────────

describe('plugins.txt', () => {
  it('separa ativo de presente — só o ativo entra na load order', () => {
    const r = parsePluginsTxt('*Skyrim.esm\n*Update.esm\nDesativado.esp\n');
    assert.deepEqual(r, [
      { name: 'Skyrim.esm', enabled: true },
      { name: 'Update.esm', enabled: true },
      { name: 'Desativado.esp', enabled: false }
    ]);
  });

  it('ignora comentário, linha vazia e espaço', () => {
    const r = parsePluginsTxt('# comentario\n\n  *Skyrim.esm  \n\n');
    assert.deepEqual(r, [{ name: 'Skyrim.esm', enabled: true }]);
  });

  it('aceita CRLF — o arquivo vem do Windows', () => {
    assert.deepEqual(
      parsePluginsTxt('*A.esm\r\n*B.esp\r\n'),
      [{ name: 'A.esm', enabled: true }, { name: 'B.esp', enabled: true }]
    );
  });

  it('entrada inválida vira lista vazia, não exceção', () => {
    for (const e of [null, undefined, 42, {}]) {
      assert.deepEqual(parsePluginsTxt(e), []);
    }
  });
});

describe('cabeçalho TES4', () => {
  it('lê os masters na ordem declarada', () => {
    const h = parsePluginHeader(fakePlugin(['Skyrim.esm', 'Update.esm']));
    assert.deepEqual(h.masters, ['Skyrim.esm', 'Update.esm']);
    assert.equal(h.error, undefined);
  });

  it('corta o NUL do fim do nome', () => {
    // Sem isso o nome carrega o byte nulo e nunca casa com o arquivo em
    // disco — o launcher acusaria "master ausente" com o master presente.
    const h = parsePluginHeader(fakePlugin(['Skyrim.esm']));
    assert.equal(h.masters[0], 'Skyrim.esm');
    assert.ok(!h.masters[0].includes(String.fromCharCode(0)));
  });

  it('reconhece as flags de master e de light', () => {
    assert.equal(parsePluginHeader(fakePlugin([], { isMaster: true })).isMaster, true);
    assert.equal(parsePluginHeader(fakePlugin([], { isLight: true })).isLight, true);
    assert.equal(parsePluginHeader(fakePlugin([])).isMaster, false);
  });

  it('arquivo que não é plugin devolve erro em vez de lixo', () => {
    const h = parsePluginHeader(Buffer.from('isto nao e um plugin do skyrim!!'));
    assert.match(h.error, /TES4/);
    assert.deepEqual(h.masters, []);
  });

  it('arquivo truncado não explode', () => {
    assert.match(parsePluginHeader(Buffer.alloc(10)).error, /menor que o cabecalho/);
    assert.match(parsePluginHeader(Buffer.alloc(0)).error, /menor que o cabecalho/);
    assert.match(parsePluginHeader(null).error, /menor que o cabecalho/);
  });

  it('dataSize mentiroso não faz o launcher ler além do arquivo', () => {
    // O tamanho vem de dentro de um arquivo que o jogador controla. Se o
    // parser confiasse nele, um .esp forjado leria memoria arbitraria.
    const b = fakePlugin(['Skyrim.esm']);
    b.writeUInt32LE(0xFFFFFFF, 4);
    const h = parsePluginHeader(b);
    assert.ok(Array.isArray(h.masters), 'deveria devolver estrutura valida');
  });
});

describe('comparação com o manifesto do servidor', () => {
  const hashOf = (nome) => ({ 'a.esm': 'h1', 'b.esp': 'h2', 'c.esp': 'ERRADO' })[nome.toLowerCase()];

  it('aprova quando tudo bate', () => {
    const r = compareMods({
      serverMods: [{ filename: 'A.esm', hash: 'h1' }, { filename: 'B.esp', hash: 'h2' }],
      localFiles: ['A.esm', 'B.esp'],
      hashOf
    });
    assert.equal(r.success, true);
  });

  it('ignora diferença de caixa — o manifesto vem de outra máquina', () => {
    const r = compareMods({
      serverMods: [{ filename: 'a.ESM', hash: 'h1' }],
      localFiles: ['A.esm'],
      hashOf
    });
    assert.equal(r.success, true, 'Windows nao distingue caixa; a verificacao tambem nao pode');
  });

  it('reprova mod ausente, dizendo qual', () => {
    const r = compareMods({
      serverMods: [{ filename: 'Faltando.esp', hash: 'h9' }],
      localFiles: ['A.esm'],
      hashOf
    });
    assert.equal(r.success, false);
    assert.match(r.error, /Faltando\.esp/);
  });

  it('reprova mod com hash diferente', () => {
    const r = compareMods({
      serverMods: [{ filename: 'C.esp', hash: 'h3' }],
      localFiles: ['C.esp'],
      hashOf
    });
    assert.equal(r.success, false);
    assert.match(r.error, /modificado ou corrompido/);
  });

  it('retorna todas as divergências em uma única verificação', () => {
    const r = compareMods({
      serverMods: [
        { filename: 'Faltando.esp', hash: 'h9' },
        { filename: 'C.esp', hash: 'h3' },
        { filename: 'Outro.bsa', hash: 'h4' }
      ],
      localFiles: ['C.esp'],
      hashOf
    });
    assert.equal(r.success, false);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems[0], /Faltando\.esp/);
    assert.match(r.problems[1], /C\.esp.*corrompido/);
    assert.match(r.problems[2], /Outro\.bsa/);
  });

  it('manifesto inválido reprova em vez de aprovar por omissão', () => {
    // Lista vazia passaria em qualquer laco. Se o servidor mandar lixo, a
    // resposta segura e "nao", nunca "sim".
    assert.equal(compareMods({ serverMods: null, localFiles: [], hashOf }).success, false);
    assert.equal(compareMods({ serverMods: undefined, localFiles: [], hashOf }).success, false);
  });
});

describe('load order', () => {
  it('aprova ordem idêntica à do servidor', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: (nome) => nome === 'HeavyRP.esm'
        ? { masters: ['Skyrim.esm'], isMaster: true, isLight: false }
        : semMasters()
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('acusa plugin exigido pelo servidor e ausente no cliente', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: semMasters
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /ausente: HeavyRP\.esm/.test(p)));
  });

  it('acusa master que carrega depois do dependente', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      serverLoadOrder: ['HeavyRP.esm', 'Skyrim.esm'],   // invertido
      readHeader: (nome) => nome === 'HeavyRP.esm'
        ? { masters: ['Skyrim.esm'], isMaster: false, isLight: false }
        : semMasters()
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /carrega depois do plugin/.test(p)));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // O caso que passava batido
  // ───────────────────────────────────────────────────────────────────────────

  it('acusa PLUGIN EXTRA — era a falha que anulava o contrato de FormID', () => {
    // O jogador tem tudo que o servidor pede, com o hash certo. Passa em
    // `compareMods` e passava em `analyzePlugins`. Mas tem um .esp a mais no
    // meio da ordem: HeavyRP.esm e 02 no servidor e 03 aqui, entao todo
    // base_id gravado no banco aponta pra outro registro na tela dele.
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'Update.esm', 'MeuMod.esp', 'HeavyRP.esm'],
      serverLoadOrder: ['Skyrim.esm', 'Update.esm', 'HeavyRP.esm'],
      enabledPlugins: ['Skyrim.esm', 'Update.esm', 'MeuMod.esp', 'HeavyRP.esm'],
      readHeader: semMasters
    });

    assert.equal(r.ok, false, 'cliente com plugin extra NAO pode ser aprovado');
    assert.ok(
      r.problems.some(p => /extra na load order: MeuMod\.esp/.test(p)),
      `deveria acusar o plugin extra. Problemas: ${JSON.stringify(r.problems)}`
    );
    assert.ok(
      r.problems.some(p => /FormID/.test(p)),
      'a mensagem precisa dizer POR QUE isso importa, senao o jogador so remove a checagem'
    );
  });

  it('plugin presente mas desativado não é problema', () => {
    // Arquivo em Data/ fora do plugins.txt nao entra na load order e nao
    // desloca indice nenhum. Acusar isso seria falso positivo, e falso
    // positivo ensina o jogador a ignorar o aviso.
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm', 'Desativado.esp'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      enabledPlugins: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: semMasters
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it('sem plugins.txt, cai para os arquivos em Data/ — direção segura', () => {
    const r = analyzePlugins({
      localPlugins: ['Skyrim.esm', 'HeavyRP.esm', 'Intruso.esp'],
      serverLoadOrder: ['Skyrim.esm', 'HeavyRP.esm'],
      readHeader: semMasters
    });
    assert.equal(r.ok, false, 'sem saber o que esta ativo, o arquivo a mais e suspeito');
  });

  it('servidor sem load order REPROVA — antes aprovava sempre', () => {
    // O codigo antigo caia para a ordem local, o que fazia a checagem comparar
    // o jogador consigo mesmo e responder "ok". A pior resposta possivel,
    // porque parece aprovacao.
    for (const ordem of [[], null, undefined]) {
      const r = analyzePlugins({
        localPlugins: ['Skyrim.esm', 'QualquerCoisa.esp'],
        serverLoadOrder: ordem,
        readHeader: semMasters
      });
      assert.equal(r.ok, false, `load order ${JSON.stringify(ordem)} nao pode ser aprovada`);
      assert.match(r.problems[0], /impossivel verificar paridade/);
    }
  });

  it('cabeçalho ilegível vira problema, não silêncio', () => {
    const r = analyzePlugins({
      localPlugins: ['Corrompido.esp'],
      serverLoadOrder: ['Corrompido.esp'],
      readHeader: () => ({ masters: [], isMaster: false, isLight: false, error: 'Cabecalho TES4 invalido' })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /TES4/.test(p)));
  });

  it('acusa master ausente', () => {
    const r = analyzePlugins({
      localPlugins: ['HeavyRP.esm'],
      serverLoadOrder: ['HeavyRP.esm'],
      readHeader: () => ({ masters: ['Skyrim.esm'], isMaster: false, isLight: false })
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /master ausente Skyrim\.esm/.test(p)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Creation Club (MOD-005)
//
// O buraco que estes testes fecham: conteúdo Creation Club nunca aparece no
// `plugins.txt`, então `analyzePlugins` é cego pra ele. O jogo carrega o que
// está no `Skyrim.ccc` sozinho, e cada plugin desses desloca índice de load
// order — mesmo efeito do "plugin extra", mesma falha silenciosa do QA 2.15.
//
// Achado ao estudar o The Divine Comedy, que tropeçou nisto e respondeu
// esvaziando o `Skyrim.ccc` — solução que o Steam desfaz ao verificar os
// arquivos. Ver docs/research/SKYMP_ECOSYSTEM_DEEP_DIVE.md §2.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCccTxt', () => {
  it('lê um nome por linha, sem asterisco', () => {
    const r = parseCccTxt('ccBGSSSE001-Fish.esm\nccQDRSSE001-SurvivalMode.esl');
    assert.deepEqual(r, ['ccBGSSSE001-Fish.esm', 'ccQDRSSE001-SurvivalMode.esl']);
  });

  it('ignora linhas vazias, espaços e comentários', () => {
    const r = parseCccTxt('  ccA.esm  \n\n# comentario\n\r\nccB.esl\n');
    assert.deepEqual(r, ['ccA.esm', 'ccB.esl']);
  });

  it('aceita CRLF', () => {
    assert.deepEqual(parseCccTxt('ccA.esm\r\nccB.esl'), ['ccA.esm', 'ccB.esl']);
  });

  it('entrada não-string vira lista vazia, não exceção', () => {
    assert.deepEqual(parseCccTxt(undefined), []);
    assert.deepEqual(parseCccTxt(null), []);
  });
});

describe('analyzeCreationClub', () => {
  const CINCO_MASTERS = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'];

  it('aprova quando não há Creation Club nenhum', () => {
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: CINCO_MASTERS,
      serverLoadOrder: CINCO_MASTERS
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, []);
  });

  it('acusa CC que o jogo carrega e o servidor não declara', () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: [...CINCO_MASTERS, 'ccBGSSSE001-Fish.esm'],
      serverLoadOrder: CINCO_MASTERS
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /ccBGSSSE001-Fish\.esm/.test(p)));
    assert.ok(r.problems.some(p => /desloca os FormIDs/.test(p)));
  });

  it('entrada no .ccc sem o arquivo em Data/ não é problema: não carrega', () => {
    // O jogador não comprou aquele CC. O nome está listado, o arquivo não
    // existe, o jogo não carrega nada e nenhum índice se move.
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: CINCO_MASTERS,
      serverLoadOrder: CINCO_MASTERS
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, []);
  });

  it('acusa CC exigido pelo servidor que este jogador não carrega', () => {
    // O risco de exigir Creation Club no modpack: só passa se todo jogador
    // tiver exatamente as mesmas licenças.
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: CINCO_MASTERS,
      serverLoadOrder: [...CINCO_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some(p => /exigido pelo servidor e ausente/.test(p)));
  });

  it('aprova quando os dois lados carregam o mesmo CC', () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccBGSSSE001-Fish.esm'],
      localPlugins: [...CINCO_MASTERS, 'ccBGSSSE001-Fish.esm'],
      serverLoadOrder: [...CINCO_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.effective, ['ccBGSSSE001-Fish.esm']);
  });

  it('plugin normal fora da ordem não é acusado como CC ausente', () => {
    // A direção inversa só vale pra nomes `cc*`; um mod comum já é coberto
    // por analyzePlugins, e acusar duas vezes confundiria o jogador.
    const r = analyzeCreationClub({
      cccEntries: [],
      localPlugins: CINCO_MASTERS,
      serverLoadOrder: [...CINCO_MASTERS, 'HeavyRP.esp']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  it('comparação é insensível a maiúsculas, como o resto do módulo', () => {
    const r = analyzeCreationClub({
      cccEntries: ['CCBGSSSE001-FISH.ESM'],
      localPlugins: [...CINCO_MASTERS, 'ccbgsssE001-fish.esm'],
      serverLoadOrder: [...CINCO_MASTERS, 'ccBGSSSE001-Fish.esm']
    });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  it('sem load order do servidor, reprova em vez de aprovar por omissão', () => {
    for (const ordem of [undefined, null, []]) {
      const r = analyzeCreationClub({
        cccEntries: ['ccA.esm'],
        localPlugins: ['ccA.esm'],
        serverLoadOrder: ordem
      });
      assert.equal(r.ok, false, `load order ${JSON.stringify(ordem)} nao pode ser aprovada`);
      assert.match(r.problems[0], /impossivel verificar paridade/);
    }
  });

  it('acusa vários CC de uma vez em vez de parar no primeiro', () => {
    const r = analyzeCreationClub({
      cccEntries: ['ccA.esm', 'ccB.esl'],
      localPlugins: [...CINCO_MASTERS, 'ccA.esm', 'ccB.esl'],
      serverLoadOrder: CINCO_MASTERS
    });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 2);
  });
});
