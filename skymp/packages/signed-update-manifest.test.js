'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, test } = require('node:test');
const {
  canonicalJson,
  enforceReleaseMonotonicity,
  parsePinnedPublicKeys,
  signUpdateManifest,
  verifyUpdateManifest,
} = require('./signed-update-manifest.js');

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function signed(overrides = {}) {
  const key = overrides.key || keys();
  return {
    key,
    envelope: signUpdateManifest({
      keyId: overrides.keyId || 'release-2026',
      sequence: overrides.sequence || 42,
      issuedAt: overrides.issuedAt || '2026-08-16T12:00:00.000Z',
      expiresAt: overrides.expiresAt || '2026-08-23T12:00:00.000Z',
      payload: overrides.payload || {
        kind: 'client',
        clientVersion: '2.0.0',
        downloadUrl: 'https://github.com/org/dist/releases/download/v2/client.zip',
        sha256: 'a'.repeat(64),
      },
      privateKey: key.privateKey,
    }),
  };
}

describe('manifesto de update assinado', () => {
  test('JSON canonico independe da ordem das chaves', () => {
    assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
    assert.throws(() => canonicalJson({ value: 1.5 }), error => error.code === 'MANIFEST_CANONICAL_VALUE');
    assert.throws(() => canonicalJson({ value: undefined }), error => error.code === 'MANIFEST_CANONICAL_VALUE');
  });

  test('assina e verifica Ed25519 com digest de release', () => {
    const { key, envelope } = signed();
    const result = verifyUpdateManifest(envelope, {
      publicKeys: { 'release-2026': key.publicKey },
      expectedKind: 'client',
      now: Date.parse('2026-08-17T00:00:00.000Z'),
    });
    assert.equal(result.payload.clientVersion, '2.0.0');
    assert.equal(result.release.sequence, 42);
    assert.match(result.release.digest, /^[a-f0-9]{64}$/);
  });

  test('Ed25519 produz assinatura deterministica para o mesmo envelope', () => {
    const key = keys();
    const first = signed({ key }).envelope;
    const second = signed({ key }).envelope;
    assert.equal(first.signature, second.signature);
  });

  test('recusa payload adulterado e assinatura por outra chave', () => {
    const { key, envelope } = signed();
    const altered = { ...envelope, payload: { ...envelope.payload, clientVersion: '9.9.9' } };
    assert.throws(
      () => verifyUpdateManifest(altered, { publicKeys: { 'release-2026': key.publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_SIGNATURE_INVALID',
    );
    const attacker = keys();
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { 'release-2026': attacker.publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_SIGNATURE_INVALID',
    );
  });

  test('recusa chave desconhecida, revogada e canal trocado', () => {
    const { envelope } = signed();
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: {}, now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_KEY_UNKNOWN',
    );
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { old: keys().publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_KEY_UNKNOWN',
    );
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { 'release-2026': keys().publicKey }, expectedKind: 'mods', now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_KIND',
    );
  });

  test('recusa manifesto expirado ou emitido no futuro fora da tolerancia', () => {
    const { key, envelope } = signed();
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { 'release-2026': key.publicKey }, now: Date.parse('2026-08-24T00:00:00.000Z'), clockSkewMs: 0 }),
      error => error.code === 'MANIFEST_EXPIRED',
    );
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { 'release-2026': key.publicKey }, now: Date.parse('2026-08-16T11:59:59.000Z'), clockSkewMs: 0 }),
      error => error.code === 'MANIFEST_NOT_YET_VALID',
    );
    assert.throws(
      () => verifyUpdateManifest(envelope, { publicKeys: { 'release-2026': key.publicKey }, now: Number.NaN }),
      error => error.code === 'MANIFEST_CLOCK',
    );
  });

  test('recusa campo externo ambiguo e validade maior que 31 dias', () => {
    const { key, envelope } = signed();
    assert.throws(
      () => verifyUpdateManifest({ ...envelope, unsignedHint: 'ignore-signature' }, { publicKeys: { 'release-2026': key.publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z') }),
      error => error.code === 'MANIFEST_UNKNOWN_FIELD',
    );
    assert.throws(
      () => signed({ expiresAt: '2026-10-01T12:00:00.000Z' }),
      error => error.code === 'MANIFEST_VALIDITY_WINDOW',
    );
  });

  test('impede downgrade e reuso de sequencia, mas permite replay identico', () => {
    const highest = { sequence: 42, digest: 'a'.repeat(64) };
    assert.throws(
      () => enforceReleaseMonotonicity({ sequence: 41, digest: 'b'.repeat(64) }, highest),
      error => error.code === 'MANIFEST_DOWNGRADE',
    );
    assert.throws(
      () => enforceReleaseMonotonicity({ sequence: 42, digest: 'b'.repeat(64) }, highest),
      error => error.code === 'MANIFEST_SEQUENCE_REUSE',
    );
    assert.deepEqual(enforceReleaseMonotonicity({ sequence: 42, digest: 'a'.repeat(64) }, highest), { ok: true });
  });

  test('valida mapa de chaves pinadas e tipo Ed25519', () => {
    const key = keys();
    assert.equal(parsePinnedPublicKeys(JSON.stringify({ current: key.publicKey })).current, key.publicKey);
    assert.throws(() => parsePinnedPublicKeys('{}'), error => error.code === 'MANIFEST_KEYS_MISSING');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
      .export({ format: 'der', type: 'spki' }).toString('base64');
    assert.throws(() => parsePinnedPublicKeys(JSON.stringify({ current: rsa })), error => error.code === 'MANIFEST_PUBLIC_KEY');
  });
});
