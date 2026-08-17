'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { signUpdateManifest } = require('../../skymp/packages/signed-update-manifest');
const { createManifestLoader, isValidManifest } = require('./modsManifest');

let root;
let keys;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-loader-v2-'));
  const pair = crypto.generateKeyPairSync('ed25519');
  keys = {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function payload(overrides = {}) {
  return {
    kind: 'parity', manifestVersion: 2, channel: 'development', build: 'test',
    generatedAt: '2026-08-16T12:00:00.000Z', extraFilePolicy: 'reject',
    files: [{ path: 'Data/Test.esp', size: 1, sha256: 'a'.repeat(64), required: true, category: 'plugin' }],
    loadOrder: ['Test.esp'], ...overrides,
  };
}
function envelope(overrides = {}) {
  return signUpdateManifest({
    keyId: 'current', sequence: overrides.sequence || 1,
    issuedAt: '2026-08-16T12:00:00.000Z', expiresAt: '2026-08-23T12:00:00.000Z',
    payload: payload(overrides.payload), privateKey: keys.privateKey,
  });
}
function write(name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}
function loader(target, publicKey = keys.publicKey) {
  return createManifestLoader(target, { publicKeys: { current: publicKey }, now: () => Date.parse('2026-08-17T00:00:00.000Z') });
}

describe('loader assinado do manifesto v2', () => {
  test('aceita payload v2 completo e expõe envelope original', () => {
    const target = write('valid.json', envelope());
    const result = loader(target).load();
    assert.equal(result.ok, true);
    assert.equal(result.manifest.files.length, 1);
    assert.equal(result.envelope.signatureVersion, 1);
  });

  test('recusa ausente, JSON inválido, v1 e forma inválida', () => {
    assert.equal(loader(path.join(root, 'missing')).load().reason, 'manifest_missing');
    assert.equal(loader(write('broken.json', '{x')).load().reason, 'manifest_invalid_json');
    assert.equal(loader(write('v1.json', envelope({ payload: { manifestVersion: 1 } }))).load().reason, 'manifest_unsupported_version');
    assert.equal(loader(write('shape.json', envelope({ payload: { files: [] } }))).load().reason, 'manifest_invalid_files');
  });

  test('recusa adulteração, chave desconhecida e manifesto expirado', () => {
    const signed = envelope();
    signed.payload.build = 'tampered';
    assert.equal(loader(write('tampered.json', signed)).load().reason, 'MANIFEST_SIGNATURE_INVALID');
    assert.equal(loader(write('wrong-key.json', envelope()), crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')).load().reason, 'MANIFEST_SIGNATURE_INVALID');
    const expiredLoader = createManifestLoader(write('expired.json', envelope()), {
      publicKeys: { current: keys.publicKey }, now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    });
    assert.equal(expiredLoader.load().reason, 'MANIFEST_EXPIRED');
  });

  test('cache é invalidado por mtime', () => {
    const target = write('cache.json', envelope());
    const instance = loader(target);
    assert.equal(instance.load().release.sequence, 1);
    fs.writeFileSync(target, JSON.stringify(envelope({ sequence: 2 })));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);
    assert.equal(instance.load().release.sequence, 2);
  });
});

test('isValidManifest usa contrato v2 estrito', () => {
  assert.equal(isValidManifest(payload()), true);
  assert.equal(isValidManifest(payload({ files: [] })), false);
});
