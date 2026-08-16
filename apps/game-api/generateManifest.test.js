/**
 * generateManifest.test.js
 *
 * O gerador do `mods.json` não tinha teste — e ele decide o contrato de FormID,
 * que é a coisa que, quando erra, não produz erro nenhum: produz um baú com
 * outra coisa dentro (`MODS_AND_GAMEMODE_CONTRACT.md` §3).
 *
 * O que estes testes travam:
 *
 *   1. **`--only-load-order` restringe o manifesto.** Sem a flag, gerar a partir
 *      de uma `Data/` de trabalho produz um manifesto que exige a máquina de
 *      quem gerou — `compareMods` reprova todo arquivo do manifesto que o
 *      cliente não tenha, então um testador com instalação limpa é barrado por
 *      um mod que não faz parte de nada.
 *   2. **A validação da load order não pode concordar consigo mesma.** Com a
 *      flag, `entries` é derivado da própria load order; se a checagem de
 *      "plugin que não existe em Data/" usasse `entries` como referência, ela
 *      passaria a aprovar qualquer coisa.
 *   3. **Load order sem `--plugins-txt` continua sendo recusada** como fonte
 *      confiável (ordem alfabética não é load order).
 *
 * Executa com: node --test generateManifest.test.js
 */

const assert = require('assert');
const { describe, it, before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GERADOR = path.join(__dirname, 'scripts', 'generate-mods-manifest.js');

let tmp, dataDir;

/** Plugin sintético — o gerador só lê bytes pra hashear, não parseia TES4. */
function escrevePlugin(nome, conteudo) {
  fs.writeFileSync(path.join(dataDir, nome), conteudo);
}

/**
 * `spawnSync` e não `execFileSync` porque o gerador escreve nos dois fluxos: o
 * progresso vai pra stdout e os avisos vão pra stderr (`console.warn`). Um
 * helper que só lê stdout no caminho de sucesso deixaria o teste do aviso
 * verde para sempre, sem nunca ver o aviso.
 */
function rodar(args) {
  const r = spawnSync(process.execPath, [GERADOR, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, saida: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  dataDir = path.join(tmp, 'Data');
  fs.mkdirSync(dataDir);

  // Três "do modpack" e dois que só existem nesta máquina.
  escrevePlugin('Skyrim.esm', 'base');
  escrevePlugin('Update.esm', 'update');
  escrevePlugin('Patch.esp', 'patch');
  escrevePlugin('ModLocal.esp', 'so nesta maquina');
  escrevePlugin('Texturas.bsa', 'bsa local');

  fs.writeFileSync(path.join(tmp, 'plugins.txt'), '*Skyrim.esm\n*Update.esm\n*Patch.esp\n');
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('--only-load-order restringe o manifesto à load order', () => {
  it('sem a flag, o manifesto carrega a Data inteira', () => {
    const out = path.join(tmp, 'cheio.json');
    const r = rodar([dataDir, '--plugins-txt', path.join(tmp, 'plugins.txt'), '--out', out]);
    assert.ok(r.ok, r.saida);

    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.manifestVersion, 1);
    assert.equal(m.channel, 'development');
    assert.equal(m.build, 'unversioned');
    assert.equal(m.sourceDataDir, undefined, 'manifesto público não pode expor path da máquina geradora');
    assert.equal(m.mods.length, 5, 'sem a flag, tudo que e plugin ou BSA entra');
    assert.equal(m.loadOrder.length, 3);
    assert.ok(
      m.mods.some(x => x.filename === 'ModLocal.esp'),
      'e exatamente por isso que a flag existe: o mod local exigiria a maquina de quem gerou'
    );
  });

  it('com a flag, só os plugins da load order entram', () => {
    const out = path.join(tmp, 'enxuto.json');
    const r = rodar([dataDir, '--plugins-txt', path.join(tmp, 'plugins.txt'), '--out', out, '--only-load-order']);
    assert.ok(r.ok, r.saida);

    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.mods.length, 3);
    assert.deepEqual(m.mods.map(x => x.filename).sort(), ['Patch.esp', 'Skyrim.esm', 'Update.esm']);
    assert.ok(
      !m.mods.some(x => x.filename === 'ModLocal.esp'),
      'mod que nao esta na load order nao pode ser exigido do cliente'
    );
  });

  it('todo arquivo do manifesto aparece na load order', () => {
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'enxuto.json'), 'utf8'));
    const ordem = new Set(m.loadOrder.map(p => p.toLowerCase()));
    for (const mod of m.mods) {
      assert.ok(ordem.has(mod.filename.toLowerCase()), `${mod.filename} esta no manifesto e fora da ordem`);
    }
  });

  it('a flag exige --plugins-txt', () => {
    const r = rodar([dataDir, '--only-load-order', '--out', path.join(tmp, 'x.json')]);
    assert.equal(r.ok, false, 'sem load order nao ha o que restringir');
    assert.match(r.saida, /exige --plugins-txt/);
  });
});

describe('a validação da load order não concorda consigo mesma', () => {
  it('plugin na ordem que não existe em Data/ reprova, mesmo com a flag', () => {
    // A regressão específica: com `--only-load-order`, `entries` é derivado da
    // load order. Se a checagem comparasse os dois, todo plugin fantasma
    // passaria — e o manifesto sairia com um plugin que ninguém tem.
    const pluginsRuim = path.join(tmp, 'plugins-fantasma.txt');
    fs.writeFileSync(pluginsRuim, '*Skyrim.esm\n*NaoExiste.esp\n');

    const r = rodar([dataDir, '--plugins-txt', pluginsRuim, '--out', path.join(tmp, 'ruim.json'), '--only-load-order']);

    assert.equal(r.ok, false, 'deveria recusar');
    assert.match(r.saida, /nao existem em Data\/: NaoExiste\.esp/);
    assert.equal(fs.existsSync(path.join(tmp, 'ruim.json')), false, 'nao pode escrever manifesto invalido');
  });
});

describe('load order sem plugins.txt é marcada como não confiável', () => {
  it('avisa e registra a procedência no manifesto', () => {
    const out = path.join(tmp, 'sem-ordem.json');
    const r = rodar([dataDir, '--out', out]);
    assert.ok(r.ok, r.saida);

    assert.match(r.saida, /AVISO/);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.match(
      m.loadOrderSource, /NAO CONFIAVEL/,
      'quem ler o manifesto depois precisa saber que a ordem foi inferida por nome de arquivo'
    );
  });
});

describe('envelope versionado do manifesto', () => {
  it('grava canal e build explícitos', () => {
    const out = path.join(tmp, 'stable.json');
    const r = rodar([
      dataDir,
      '--plugins-txt', path.join(tmp, 'plugins.txt'),
      '--out', out,
      '--channel', 'stable',
      '--build', '2026.08.16-rc1'
    ]);
    assert.ok(r.ok, r.saida);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(
      { manifestVersion: m.manifestVersion, channel: m.channel, build: m.build },
      { manifestVersion: 1, channel: 'stable', build: '2026.08.16-rc1' }
    );
  });

  it('recusa canal desconhecido e build vazio', () => {
    const invalidChannel = rodar([dataDir, '--channel', 'nightly']);
    const invalidBuild = rodar([dataDir, '--build', '']);
    assert.equal(invalidChannel.ok, false);
    assert.match(invalidChannel.saida, /Canal invalido/);
    assert.equal(invalidBuild.ok, false);
    assert.match(invalidBuild.saida, /--build precisa/);
  });

  it('não publica o caminho absoluto da máquina geradora', () => {
    const out = path.join(tmp, 'sem-path-privado.json');
    const r = rodar([
      dataDir,
      '--plugins-txt', path.join(tmp, 'plugins.txt'),
      '--out', out
    ]);
    assert.ok(r.ok, r.saida);
    const m = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(m.sourceDataDir, undefined);
    assert.equal(JSON.stringify(m).includes(dataDir), false);
  });
});
