export const MODS_MANIFEST_VERSION: number;
export const MODS_MANIFEST_CHANNELS: readonly string[];

export function validateModsManifestContract(data: unknown):
  | { ok: true }
  | { ok: false; reason: string };

