import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import manifestContract from '../../../skymp/packages/mods-manifest-contract.js';

const { normalizeManifestPath, validateModsManifestContract } = manifestContract;

function manifest(overrides = {}) {
  return {
    manifestVersion: 2,
    channel: 'development',
    build: 'test-build',
    generatedAt: '2026-08-16T12:00:00.000Z',
    extraFilePolicy: 'reject',
    files: [{
      path: 'Data/HeavyRP.esp', size: 10, sha256: 'a'.repeat(64), required: true,
      category: 'plugin', downloadUrl: 'https://github.com/org/dist/releases/download/mod/HeavyRP.esp',
    }],
    loadOrder: ['HeavyRP.esp'],
    ...overrides,
  };
}

describe('contrato v2 de paridade consumido pelo launcher', () => {
  test('aceita manifesto completo v2', () => {
    assert.deepEqual(validateModsManifestContract(manifest({
      ignoredPaths: ['Data/Platform/Plugins/skymp5-client-settings.txt'],
    })), { ok: true });
    const withAsset = manifest({ files: [...manifest().files, {
      path: 'Data/meshes/custom-item.nif', size: 5, sha256: 'b'.repeat(64), required: true, category: 'asset',
    }] });
    assert.deepEqual(validateModsManifestContract(withAsset), { ok: true });
  });

  test('paths ignorados são exatos, únicos e não podem colidir com arquivos', () => {
    assert.equal(validateModsManifestContract(manifest({ ignoredPaths: ['Data/../x'] })).reason, 'manifest_invalid_ignored_path');
    assert.equal(validateModsManifestContract(manifest({ ignoredPaths: ['Data/a.txt', 'data/A.TXT'] })).reason, 'manifest_ignored_path_collision');
    assert.equal(validateModsManifestContract(manifest({ ignoredPaths: ['Data/HeavyRP.esp'] })).reason, 'manifest_ignored_path_is_file');
    assert.equal(validateModsManifestContract(manifest({ ignoredPaths: 'Data/a.txt' })).reason, 'manifest_invalid_ignored_paths');
  });

  test('recusa legado e versão futura', () => {
    assert.equal(validateModsManifestContract({ manifestVersion: 1 }).reason, 'manifest_unsupported_version');
    assert.equal(validateModsManifestContract(manifest({ manifestVersion: 3 })).reason, 'manifest_unsupported_version');
  });

  test('normaliza somente paths seguros sob Data', () => {
    assert.equal(normalizeManifestPath('Data/SKSE/Plugins/a.dll'), 'Data/SKSE/Plugins/a.dll');
    for (const unsafe of ['../x', 'Data/../x', '/Data/x', 'C:/x', 'Data\\x', 'Data/CON', 'Data/a. ', 'mods/x']) {
      assert.equal(normalizeManifestPath(unsafe), null, unsafe);
    }
  });

  test('recusa colisão case-insensitive, SHA/tamanho e URL inválidos', () => {
    const base = manifest().files[0];
    assert.equal(validateModsManifestContract(manifest({ files: [base, { ...base, path: 'data/heavyrp.ESP' }] })).reason, 'manifest_path_collision');
    assert.equal(validateModsManifestContract(manifest({ files: [{ ...base, sha256: 'md5' }] })).reason, 'manifest_invalid_sha256');
    assert.equal(validateModsManifestContract(manifest({ files: [{ ...base, size: -1 }] })).reason, 'manifest_invalid_size');
    assert.equal(validateModsManifestContract(manifest({ files: [{ ...base, downloadUrl: 'http://example.com/a' }] })).reason, 'manifest_invalid_download_url');
  });

  test('load order deve ser única e possuir plugin correspondente', () => {
    assert.equal(validateModsManifestContract(manifest({ loadOrder: ['Missing.esp'] })).reason, 'manifest_load_order_file_missing');
    assert.equal(validateModsManifestContract(manifest({ loadOrder: ['HeavyRP.esp', 'heavyrp.ESP'] })).reason, 'manifest_load_order_duplicate');
  });

  test('recusa canal, build, timestamp e política de extras inválidos', () => {
    assert.equal(validateModsManifestContract(manifest({ channel: 'nightly' })).reason, 'manifest_invalid_channel');
    assert.equal(validateModsManifestContract(manifest({ build: ' ' })).reason, 'manifest_invalid_build');
    assert.equal(validateModsManifestContract(manifest({ generatedAt: 'hoje' })).reason, 'manifest_invalid_generated_at');
    assert.equal(validateModsManifestContract(manifest({ extraFilePolicy: 'delete' })).reason, 'manifest_invalid_extra_policy');
  });
});
