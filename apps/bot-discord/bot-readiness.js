'use strict';

function getBotReadiness(client) {
  const ready = Boolean(client && typeof client.isReady === 'function' && client.isReady());
  return { ready, checks: { discord: ready } };
}

module.exports = { getBotReadiness };
