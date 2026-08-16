export const MIN_SKYMP_SESSION_LENGTH = 32;
export const MAX_SKYMP_SESSION_LENGTH = 512;

export function validateSkyMpSession(session) {
  if (typeof session !== 'string') {
    throw new TypeError('SkyMP session must be a string');
  }

  if (session.length < MIN_SKYMP_SESSION_LENGTH || session.length > MAX_SKYMP_SESSION_LENGTH) {
    throw new RangeError(
      `SkyMP session length must be between ${MIN_SKYMP_SESSION_LENGTH} and ${MAX_SKYMP_SESSION_LENGTH}`
    );
  }

  if (/\s/.test(session)) {
    throw new TypeError('SkyMP session must not contain whitespace');
  }

  return session;
}

export function buildSkyMpClientSettings(currentSettings, options) {
  const session = validateSkyMpSession(options?.session);
  const serverIp = String(options?.serverIp || '').trim();
  const serverPort = Number(options?.serverPort);

  if (!serverIp) throw new TypeError('SkyMP server IP is required');
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new RangeError('SkyMP server port must be an integer between 1 and 65535');
  }

  const settings = currentSettings && typeof currentSettings === 'object' && !Array.isArray(currentSettings)
    ? { ...currentSettings }
    : {};
  const currentGameData = settings.gameData && typeof settings.gameData === 'object' && !Array.isArray(settings.gameData)
    ? settings.gameData
    : {};

  settings.gameData = { ...currentGameData, session };
  delete settings.gameData.profileId;
  delete settings.gameData.launcherTicket;
  delete settings.gameData.token;

  settings['server-ip'] = serverIp;
  settings['server-port'] = serverPort;
  settings.master = '';

  return settings;
}

