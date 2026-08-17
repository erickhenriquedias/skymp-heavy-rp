import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import signedManifest from '../../../skymp/packages/signed-update-manifest.js';
import {
  chooseHighestRelease,
  readInstalledRelease,
  readRememberedReleases,
  rememberAcceptedRelease,
  serializeReleaseState,
  verifySignedUpdateEnvelope,
} from './update-manifest-security.mjs';

const { signUpdateManifest } = signedManifest;

function fixtureEnvelope(sequence = 10) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const envelope = signUpdateManifest({
    keyId: 'current', sequence,
    issuedAt: '2026-08-16T12:00:00.000Z', expiresAt: '2026-08-23T12:00:00.000Z',
    payload: { kind: 'mods', modsVersion: '10', downloadUrl: 'https://github.com/a/b/releases/download/mods/mods.zip', sha256: 'b'.repeat(64) },
    privateKey,
  });
  return { envelope, publicKey };
}

describe('estado anti-downgrade do launcher', () => {
  test('persiste maior release aceita atomicamente e a relê', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-update-security-'));
    try {
      const statePath = path.join(root, 'user-data', 'update-security.json');
      const { envelope, publicKey } = fixtureEnvelope();
      const verified = verifySignedUpdateEnvelope(envelope, {
        kind: 'mods', publicKeys: JSON.stringify({ current: publicKey }),
        now: Date.parse('2026-08-17T00:00:00.000Z'),
      });
      rememberAcceptedRelease(statePath, 'mods', verified.release);
      assert.deepEqual(readRememberedReleases(statePath).mods, verified.release);
      assert.match(serializeReleaseState(verified.release), /"sequence": 10/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('mantém high-watermarks independentes por tipo e canal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-update-channels-'));
    try {
      const statePath = path.join(root, 'update-security.json');
      const base = {
        keyId: 'current', digest: 'a'.repeat(64),
        issuedAt: '2026-08-16T12:00:00.000Z', expiresAt: '2026-08-23T12:00:00.000Z',
      };
      rememberAcceptedRelease(statePath, 'mods:stable', { ...base, sequence: 2, channel: 'stable' });
      rememberAcceptedRelease(statePath, 'mods:beta', { ...base, sequence: 20, channel: 'beta' });
      const releases = readRememberedReleases(statePath);
      assert.equal(releases['mods:stable'].sequence, 2);
      assert.equal(releases['mods:beta'].sequence, 20);
      assert.equal(releases['mods:stable'].channel, 'stable');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('maior estado lembrado vence rollback do arquivo instalado', () => {
    const old = { sequence: 9, digest: 'a'.repeat(64) };
    const remembered = { sequence: 10, digest: 'b'.repeat(64) };
    assert.equal(chooseHighestRelease(old, remembered), remembered);
  });

  test('estado de mesma sequencia com digest divergente falha fechado', () => {
    assert.throws(
      () => chooseHighestRelease({ sequence: 10, digest: 'a'.repeat(64) }, { sequence: 10, digest: 'b'.repeat(64) }),
      error => error.code === 'UPDATE_SECURITY_STATE_CONFLICT',
    );
  });

  test('arquivo instalado corrompido nao vira ausencia silenciosa', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-update-security-'));
    try {
      await fs.writeFile(path.join(root, 'release.json'), '{broken');
      assert.throws(() => readInstalledRelease(root, 'release.json'), error => error.code === 'UPDATE_SECURITY_STATE_INVALID');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('feed antigo e recusado mesmo apos rollback local', () => {
    const current = fixtureEnvelope(10);
    const old = fixtureEnvelope(9);
    const accepted = verifySignedUpdateEnvelope(current.envelope, {
      kind: 'mods', publicKeys: { current: current.publicKey }, now: Date.parse('2026-08-17T00:00:00.000Z'),
    });
    assert.throws(
      () => verifySignedUpdateEnvelope(old.envelope, {
        kind: 'mods', publicKeys: { current: old.publicKey }, rememberedRelease: accepted.release,
        now: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      error => error.code === 'MANIFEST_DOWNGRADE',
    );
  });

  test('lock de outro processo falha fechado e lock orfao e recuperado', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-update-security-'));
    try {
      const statePath = path.join(root, 'update-security.json');
      const release = {
        sequence: 1, keyId: 'current', digest: 'a'.repeat(64),
        issuedAt: '2026-08-16T12:00:00.000Z', expiresAt: '2026-08-23T12:00:00.000Z',
      };
      await fs.writeFile(`${statePath}.lock`, JSON.stringify({ pid: process.pid }));
      assert.throws(() => rememberAcceptedRelease(statePath, 'client', release), error => error.code === 'UPDATE_SECURITY_STATE_LOCKED');
      await fs.writeFile(`${statePath}.lock`, JSON.stringify({ pid: 2147483647 }));
      rememberAcceptedRelease(statePath, 'client', release);
      assert.equal(readRememberedReleases(statePath).client.sequence, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
