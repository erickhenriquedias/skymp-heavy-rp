const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createManifestLoader, isValidManifest } = require('./modsManifest');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-manifest-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function publishableEnvelope(content) {
  return {
    manifestVersion: 1,
    channel: 'development',
    build: 'test-build',
    ...content
  };
}

describe('validação de forma do manifesto', () => {
  test('aceita manifesto bem formado', () => {
    assert.equal(isValidManifest({
      mods: [{ filename: 'Skyrim.esm', hash: 'abc' }],
      loadOrder: ['Skyrim.esm']
    }), true);
  });

  test('manifesto vazio é uma forma reconhecível, mas não publicável', () => {
    assert.equal(isValidManifest({ mods: [], loadOrder: [] }), true);
  });

  test('rejeita mod sem hash', () => {
    assert.equal(isValidManifest({ mods: [{ filename: 'a.esp' }], loadOrder: [] }), false);
  });

  test('rejeita mod sem filename', () => {
    assert.equal(isValidManifest({ mods: [{ hash: 'abc' }], loadOrder: [] }), false);
  });

  test('rejeita ausência de loadOrder', () => {
    assert.equal(isValidManifest({ mods: [] }), false);
  });

  test('rejeita não-objeto', () => {
    assert.equal(isValidManifest(null), false);
    assert.equal(isValidManifest('{}'), false);
  });
});

describe('loader', () => {
  test('manifesto ausente reporta erro em vez de lista vazia', () => {
    // Este é o ponto central: lista vazia passaria na verificação de paridade
    // do launcher e deixaria qualquer modpack entrar.
    const loader = createManifestLoader(path.join(tmpDir, 'nao-existe.json'));
    const result = loader.load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_missing');
    assert.equal(result.manifest, undefined);
  });

  test('JSON corrompido reporta erro', () => {
    const p = writeManifest('corrompido.json', '{ isso nao e json');
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_invalid_json');
  });

  test('forma inválida reporta erro', () => {
    const p = writeManifest('forma-errada.json', publishableEnvelope({
      mods: [{ filename: 'a.esp' }],
      loadOrder: []
    }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_invalid_shape');
  });

  test('manifesto legado sem versão é recusado explicitamente', () => {
    const p = writeManifest('legado.json', {
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }],
      loadOrder: ['Skyrim.esm']
    });
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_unsupported_version');
  });

  test('versão futura desconhecida falha fechado', () => {
    const p = writeManifest('futuro.json', publishableEnvelope({
      manifestVersion: 2,
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }],
      loadOrder: ['Skyrim.esm']
    }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_unsupported_version');
  });

  test('canal e build inválidos possuem recusas próprias', () => {
    const invalidChannel = writeManifest('canal-invalido.json', publishableEnvelope({
      channel: 'nightly',
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }],
      loadOrder: ['Skyrim.esm']
    }));
    const invalidBuild = writeManifest('build-invalido.json', publishableEnvelope({
      build: ' ',
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }],
      loadOrder: ['Skyrim.esm']
    }));
    assert.equal(createManifestLoader(invalidChannel).load().reason, 'manifest_invalid_channel');
    assert.equal(createManifestLoader(invalidBuild).load().reason, 'manifest_invalid_build');
  });

  test('manifesto totalmente vazio falha fechado com motivo próprio', () => {
    const p = writeManifest('vazio.json', publishableEnvelope({ mods: [], loadOrder: [] }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_empty');
  });

  test('lista de mods vazia não é publicada mesmo com load order', () => {
    const p = writeManifest('mods-vazios.json', publishableEnvelope({
      mods: [],
      loadOrder: ['Skyrim.esm']
    }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_empty');
  });

  test('load order vazia não é publicada mesmo com arquivo listado', () => {
    const p = writeManifest('ordem-vazia.json', publishableEnvelope({
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }],
      loadOrder: []
    }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manifest_empty');
  });

  test('carrega manifesto válido', () => {
    const p = writeManifest('valido.json', publishableEnvelope({
      mods: [{ filename: 'Skyrim.esm', hash: 'd0' }, { filename: 'HeavyRP.esm', hash: 'a1' }],
      loadOrder: ['Skyrim.esm', 'HeavyRP.esm']
    }));
    const result = createManifestLoader(p).load();
    assert.equal(result.ok, true);
    assert.equal(result.manifest.mods.length, 2);
    assert.deepEqual(result.manifest.loadOrder, ['Skyrim.esm', 'HeavyRP.esm']);
  });

  test('recarrega quando o arquivo muda no disco', () => {
    const p = writeManifest('cache.json', publishableEnvelope({
      mods: [{ filename: 'a.esp', hash: '1' }],
      loadOrder: ['a.esp']
    }));
    const loader = createManifestLoader(p);

    assert.equal(loader.load().manifest.mods.length, 1);

    // mtime tem granularidade de ms em alguns sistemas; forçamos um valor
    // distinto pra garantir que o teste exercite a invalidação e não o acaso.
    fs.writeFileSync(p, JSON.stringify(publishableEnvelope({
      mods: [{ filename: 'a.esp', hash: '1' }, { filename: 'b.esp', hash: '2' }],
      loadOrder: ['a.esp', 'b.esp']
    })));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);

    assert.equal(loader.load().manifest.mods.length, 2, 'o cache deveria ter sido invalidado pelo mtime');
  });
});
