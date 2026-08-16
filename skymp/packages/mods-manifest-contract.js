'use strict';

const MODS_MANIFEST_VERSION = 1;
const MODS_MANIFEST_CHANNELS = Object.freeze(['development', 'beta', 'stable']);

function validateModsManifestContract(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: 'manifest_invalid_shape' };
  }
  if (data.manifestVersion !== MODS_MANIFEST_VERSION) {
    return { ok: false, reason: 'manifest_unsupported_version' };
  }
  if (!MODS_MANIFEST_CHANNELS.includes(data.channel)) {
    return { ok: false, reason: 'manifest_invalid_channel' };
  }
  if (typeof data.build !== 'string' || data.build.trim().length === 0 || data.build.length > 128) {
    return { ok: false, reason: 'manifest_invalid_build' };
  }
  return { ok: true };
}

module.exports = {
  MODS_MANIFEST_VERSION,
  MODS_MANIFEST_CHANNELS,
  validateModsManifestContract,
};

