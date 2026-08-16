import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import manifestContract from '../../../skymp/packages/mods-manifest-contract.js';

const { validateModsManifestContract } = manifestContract;

function envelope(overrides = {}) {
  return {
    manifestVersion: 1,
    channel: 'development',
    build: 'test-build',
    ...overrides,
  };
}

describe('contrato de mods consumido pelo launcher', () => {
  test('aceita exatamente a versão conhecida', () => {
    assert.deepEqual(validateModsManifestContract(envelope()), { ok: true });
  });

  test('recusa manifesto legado e versão futura', () => {
    assert.equal(validateModsManifestContract({}).reason, 'manifest_unsupported_version');
    assert.equal(
      validateModsManifestContract(envelope({ manifestVersion: 2 })).reason,
      'manifest_unsupported_version',
    );
  });

  test('recusa canal desconhecido', () => {
    assert.equal(
      validateModsManifestContract(envelope({ channel: 'nightly' })).reason,
      'manifest_invalid_channel',
    );
  });

  test('recusa build vazio ou excessivamente longo', () => {
    assert.equal(validateModsManifestContract(envelope({ build: ' ' })).reason, 'manifest_invalid_build');
    assert.equal(
      validateModsManifestContract(envelope({ build: 'x'.repeat(129) })).reason,
      'manifest_invalid_build',
    );
  });
});

