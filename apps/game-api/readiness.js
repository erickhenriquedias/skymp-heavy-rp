'use strict';

function createReadinessProbe({ execute, loadManifest, isMaintenance }) {
  if (typeof execute !== 'function') throw new TypeError('execute deve ser função');
  if (typeof loadManifest !== 'function') throw new TypeError('loadManifest deve ser função');
  if (typeof isMaintenance !== 'function') throw new TypeError('isMaintenance deve ser função');

  return async function checkReadiness() {
    let manifest = false;
    let database = false;
    try { manifest = loadManifest()?.ok === true; } catch (_) { manifest = false; }
    try {
      const rows = await execute('SELECT 1 AS ready');
      database = Array.isArray(rows) && Number(rows[0]?.ready) === 1;
    } catch (_) {
      database = false;
    }
    const maintenance = isMaintenance() === true;
    return {
      ready: database && manifest && !maintenance,
      checks: {
        database: database ? 'ok' : 'unavailable',
        manifest: manifest ? 'ok' : 'unavailable',
        maintenance: maintenance ? 'active' : 'inactive'
      }
    };
  };
}

module.exports = { createReadinessProbe };
