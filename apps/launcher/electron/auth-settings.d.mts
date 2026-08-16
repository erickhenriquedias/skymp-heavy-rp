export const MIN_SKYMP_SESSION_LENGTH: number;
export const MAX_SKYMP_SESSION_LENGTH: number;

export function validateSkyMpSession(session: unknown): string;

export function buildSkyMpClientSettings(
  currentSettings: unknown,
  options: {
    session: unknown;
    serverIp: unknown;
    serverPort: unknown;
  }
): Record<string, any>;

