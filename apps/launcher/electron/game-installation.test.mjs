import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspectSteamSkyrimInstallation, normalizeSkyrimVersion } from './game-installation.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-steam-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'Data'));
  await fs.writeFile(path.join(root, 'SkyrimSE.exe'), 'fixture');
  await fs.writeFile(path.join(root, 'steam_api64.dll'), 'fixture');
  return root;
}

describe('instalação Steam obrigatória do Skyrim', () => {
  test('aceita somente a versão Steam 1.6.1170.0', async () => {
    const root = await fixture();
    const result = await inspectSteamSkyrimInstallation(root, { readExecutableVersion: async () => '1.6.1170.0' });
    assert.deepEqual(result, { ok: true, reason: 'ok', platform: 'steam', version: '1.6.1170.0' });
  });

  test('recusa GOG mesmo com DLL Steam copiada', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'goggame-1711230643.info'), 'fixture');
    const result = await inspectSteamSkyrimInstallation(root, { readExecutableVersion: async () => '1.6.1170.0' });
    assert.equal(result.reason, 'gog');
  });

  test('recusa pasta sem identidade Steam e sem Data', async () => {
    const noSteam = await fixture();
    await fs.unlink(path.join(noSteam, 'steam_api64.dll'));
    assert.equal((await inspectSteamSkyrimInstallation(noSteam, { readExecutableVersion: async () => '1.6.1170.0' })).reason, 'not-steam');
    const noData = await fixture();
    await fs.rm(path.join(noData, 'Data'), { recursive: true });
    assert.equal((await inspectSteamSkyrimInstallation(noData, { readExecutableVersion: async () => '1.6.1170.0' })).reason, 'no-data');
  });

  test('recusa executável ausente, versão divergente e versão ilegível', async () => {
    const missing = await fixture();
    await fs.unlink(path.join(missing, 'SkyrimSE.exe'));
    assert.equal((await inspectSteamSkyrimInstallation(missing, { readExecutableVersion: async () => '1.6.1170.0' })).reason, 'no-skyrim');
    const wrong = await fixture();
    const mismatch = await inspectSteamSkyrimInstallation(wrong, { readExecutableVersion: async () => '1.6.640.0' });
    assert.equal(mismatch.reason, 'unsupported-version');
    assert.equal(mismatch.requiredVersion, '1.6.1170.0');
    const unreadable = await fixture();
    assert.equal((await inspectSteamSkyrimInstallation(unreadable, { readExecutableVersion: async () => 'unknown' })).reason, 'version-unreadable');
  });

  test('normaliza metadado Windows com três componentes', () => {
    assert.equal(normalizeSkyrimVersion('1.6.1170'), '1.6.1170.0');
    assert.equal(normalizeSkyrimVersion(' 1.6.1170.0 '), '1.6.1170.0');
    assert.equal(normalizeSkyrimVersion('garbage'), null);
  });
});
