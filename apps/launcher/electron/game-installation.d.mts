export const REQUIRED_SKYRIM_VERSION: string;
export function normalizeSkyrimVersion(value: unknown): string | null;
export function inspectSteamSkyrimInstallation(
  folderPath: string,
  options: { readExecutableVersion?: (filePath: string) => Promise<string> | string },
): Promise<{ ok: boolean; reason: string; message?: string; platform?: string; version?: string; requiredVersion?: string }>;
