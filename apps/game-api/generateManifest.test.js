'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { verifyUpdateManifest } = require('../../skymp/packages/signed-update-manifest');
const { generate, listFilesRecursive } = require('./scripts/generate-mods-manifest');

let root;
let dataDir;
let pluginsPath;
let keys;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-v2-'));
  dataDir = path.join(root, 'Data');
  fs.mkdirSync(path.join(dataDir, 'SKSE', 'Plugins'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Skyrim.esm'), 'base');
  fs.writeFileSync(path.join(dataDir, 'Patch.esp'), 'patch');
  fs.writeFileSync(path.join(dataDir, 'Textures.bsa'), 'archive');
  fs.writeFileSync(path.join(dataDir, 'SKSE', 'Plugins', 'Heavy.dll'), 'binary');
  fs.mkdirSync(path.join(dataDir, 'Platform', 'Plugins', 'Heavy'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'meshes'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Platform', 'Plugins', 'Heavy', 'index.js'), 'script');
  fs.writeFileSync(path.join(dataDir, 'Platform', 'Plugins', 'Heavy', 'menu.css'), 'asset');
  fs.writeFileSync(path.join(dataDir, 'Platform', 'Plugins', 'skymp5-client-settings.txt'), 'dynamic session');
  fs.writeFileSync(path.join(dataDir, 'meshes', 'custom-item.nif'), 'mesh', { flag: 'w' });
  pluginsPath = path.join(root, 'plugins.txt');
  fs.writeFileSync(pluginsPath, '*Skyrim.esm\n*Patch.esp\n');
  const pair = crypto.generateKeyPairSync('ed25519');
  keys = {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function args(extra = []) {
  return [dataDir, '--plugins-txt', pluginsPath, '--build', '2026.08.16', '--sequence', '7', '--key-id', 'current', ...extra];
}

describe('gerador assinado do manifesto v2', () => {
  test('gera paths recursivos, tamanho e SHA-256 dentro de envelope verificável', async () => {
    const { envelope } = await generate(args(), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey }, new Date('2026-08-16T12:00:00.000Z'));
    const verified = verifyUpdateManifest(envelope, {
      publicKeys: { current: keys.publicKey }, expectedKind: 'parity', now: Date.parse('2026-08-17T00:00:00.000Z'),
    });
    assert.equal(verified.payload.manifestVersion, 2);
    assert.equal(verified.payload.files.length, 7);
    assert.ok(verified.payload.files.every(file => file.path.startsWith('Data/') && /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.ok(verified.payload.files.some(file => file.path === 'Data/SKSE/Plugins/Heavy.dll' && file.category === 'binary'));
    assert.ok(verified.payload.files.some(file => file.path.endsWith('/index.js') && file.category === 'script'));
    assert.ok(verified.payload.files.some(file => file.path.endsWith('/custom-item.nif') && file.category === 'asset'));
    assert.deepEqual(verified.payload.ignoredPaths, ['Data/Platform/Plugins/skymp5-client-settings.txt']);
    assert.equal(verified.payload.files.some(file => file.path.endsWith('/skymp5-client-settings.txt')), false);
    assert.equal(JSON.stringify(envelope).includes(dataDir), false);
  });

  test('--only-load-order restringe aos plugins ativos', async () => {
    const { envelope } = await generate(args(['--only-load-order']), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey });
    assert.deepEqual(envelope.payload.files.map(file => file.path).sort(), ['Data/Patch.esp', 'Data/Skyrim.esm']);
  });

  test('distribution-map adiciona URL somente ao arquivo autorizado', async () => {
    const mapPath = path.join(root, 'distribution.json');
    fs.writeFileSync(mapPath, JSON.stringify({ 'Data/Patch.esp': 'https://github.com/org/dist/releases/download/mod/Patch.esp' }));
    const { envelope } = await generate(args(['--distribution-map', mapPath]), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey });
    assert.equal(envelope.payload.files.find(file => file.path === 'Data/Patch.esp').downloadUrl.includes('github.com'), true);
    assert.equal(envelope.payload.files.find(file => file.path === 'Data/Skyrim.esm').downloadUrl, undefined);
  });

  test('--ignore-path adiciona exceção exata e recusa path inseguro', async () => {
    const { envelope } = await generate(args(['--ignore-path', 'Data/Platform/Plugins/Heavy/menu.css']), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey });
    assert.equal(envelope.payload.files.some(file => file.path.endsWith('/menu.css')), false);
    assert.ok(envelope.payload.ignoredPaths.includes('Data/Platform/Plugins/Heavy/menu.css'));
    await assert.rejects(() => generate(args(['--ignore-path', 'Data/../escape.txt']), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey }), /Path ignorado invalido/);
  });

  test('recusa plugin fantasma, mapa desconhecido e ausência de chave', async () => {
    fs.writeFileSync(pluginsPath, '*Skyrim.esm\n*Fantasma.esp\n');
    await assert.rejects(() => generate(args(), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey }), /nao existem/);
    fs.writeFileSync(pluginsPath, '*Skyrim.esm\n*Patch.esp\n');
    const mapPath = path.join(root, 'bad-map.json');
    fs.writeFileSync(mapPath, JSON.stringify({ 'Data/Outro.esp': 'https://github.com/a/b/releases/x' }));
    await assert.rejects(() => generate(args(['--distribution-map', mapPath]), { UPDATE_SIGNING_PRIVATE_KEY: keys.privateKey }), /fora do manifesto/);
    await assert.rejects(() => generate(args(), {}), /UPDATE_SIGNING_PRIVATE_KEY ausente/);
  });

  test('recusa symlink na árvore quando a plataforma permite criá-lo', () => {
    const link = path.join(dataDir, 'linked.esp');
    try { fs.symlinkSync(path.join(dataDir, 'Patch.esp'), link); }
    catch { return; }
    assert.throws(() => listFilesRecursive(dataDir), /Link simbolico recusado/);
    fs.unlinkSync(link);
  });
});
