'use strict';

const fs = require('node:fs');
const { validateModsManifestContract } = require('./mods-manifest-contract');
const { parsePinnedPublicKeys, verifyUpdateManifest } = require('./signed-update-manifest');

function isValidManifest(data) {
  return validateModsManifestContract(data).ok;
}

function createManifestLoader(manifestPath, options = {}) {
  let cached = null;
  let cachedMtimeMs = null;

  function load() {
    let stat;
    try { stat = fs.statSync(manifestPath); }
    catch { return { ok: false, reason: 'manifest_missing' }; }
    let envelope;
    if (cached && cachedMtimeMs === stat.mtimeMs) {
      envelope = cached.envelope;
    } else {
      try { envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
      catch { return { ok: false, reason: 'manifest_invalid_json' }; }
    }

    try {
      const publicKeys = typeof options.publicKeys === 'string'
        ? parsePinnedPublicKeys(options.publicKeys)
        : options.publicKeys;
      const verified = verifyUpdateManifest(envelope, {
        publicKeys, expectedKind: 'parity', now: options.now?.(),
      });
      const contract = validateModsManifestContract(verified.payload);
      if (!contract.ok) return contract;
      cached = { envelope, manifest: verified.payload, release: verified.release };
      cachedMtimeMs = stat.mtimeMs;
      return { ok: true, ...cached };
    } catch (error) {
      return { ok: false, reason: error?.code || 'manifest_signature_invalid' };
    }
  }

  return { load };
}

module.exports = { createManifestLoader, isValidManifest };
