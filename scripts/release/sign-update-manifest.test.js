'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const { verifyUpdateManifest } = require('../../skymp/packages/signed-update-manifest.js');
const { generateKeypair } = require('./generate-update-keypair.js');
const { buildSignedManifest, parseArgs, writeManifestAtomic } = require('./sign-update-manifest.js');

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

describe('CLI de assinatura de manifests', () => {
  test('gera Ed25519 e recusa sobrescrever a chave privada', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skyrp-keygen-'));
    try {
      const privateOut = path.join(root, 'release.update-signing.pk8.base64');
      const generated = generateKeypair('release-2026', privateOut);
      const privateKey = (await fsp.readFile(privateOut, 'utf8')).trim();
      const input = path.join(root, 'payload.json');
      await fsp.writeFile(input, JSON.stringify({ channel: 'stable', clientVersion: '1' }));
      const options = parseArgs(['--input', input, '--output', path.join(root, 'out.json'), '--kind', 'client', '--sequence', '1', '--key-id', 'release-2026']);
      const envelope = buildSignedManifest(options, privateKey, new Date('2026-08-16T12:00:00.000Z'));
      assert.equal(verifyUpdateManifest(envelope, {
        publicKeys: { 'release-2026': generated.publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z'),
      }).release.sequence, 1);
      assert.throws(() => generateKeypair('release-2026', privateOut), error => error.code === 'EEXIST');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test('monta envelope verificavel sem imprimir ou gravar a chave privada', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skyrp-sign-'));
    try {
      const input = path.join(root, 'payload.json');
      const output = path.join(root, 'signed.json');
      await fsp.writeFile(input, JSON.stringify({ channel: 'stable', clientVersion: '3', downloadUrl: 'https://github.com/a/b/releases/x.zip', sha256: 'a'.repeat(64) }));
      const key = keys();
      const options = parseArgs(['--input', input, '--output', output, '--kind', 'client', '--sequence', '3', '--key-id', 'current', '--expires-hours', '24']);
      const manifest = buildSignedManifest(options, key.privateKey, new Date('2026-08-16T12:00:00.000Z'));
      writeManifestAtomic(output, manifest);
      const serialized = fs.readFileSync(output, 'utf8');
      assert.equal(serialized.includes(key.privateKey), false);
      const verified = verifyUpdateManifest(JSON.parse(serialized), {
        publicKeys: { current: key.publicKey }, expectedKind: 'client', now: Date.parse('2026-08-17T00:00:00.000Z'),
      });
      assert.equal(verified.release.sequence, 3);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test('recusa argumentos ambiguos, kind divergente e campo reservado', async () => {
    assert.throws(() => parseArgs(['--kind', 'client']), /Falta --input/);
    assert.throws(
      () => parseArgs(['--input', 'a', '--output', 'b', '--kind', 'client', '--sequence', '1', '--key-id', 'x', '--expires-at', 'x', '--expires-hours', '1']),
      /somente/,
    );
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'skyrp-sign-'));
    try {
      const input = path.join(root, 'payload.json');
      await fsp.writeFile(input, JSON.stringify({ kind: 'mods', channel: 'stable' }));
      const options = parseArgs(['--input', input, '--output', path.join(root, 'out'), '--kind', 'client', '--sequence', '1', '--key-id', 'x']);
      assert.throws(() => buildSignedManifest(options, keys().privateKey), /declara kind=mods/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test('recusa assinar payload sem canal conhecido', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sign-update-channel-'));
    try {
      const input = path.join(root, 'payload.json');
      await fsp.writeFile(input, JSON.stringify({ clientVersion: '1' }));
      const options = parseArgs(['--input', input, '--output', path.join(root, 'out'), '--kind', 'client', '--sequence', '1', '--key-id', 'x']);
      assert.throws(() => buildSignedManifest(options, keys().privateKey), /channel=stable/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
