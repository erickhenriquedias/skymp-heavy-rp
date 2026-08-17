export const MODS_MANIFEST_VERSION: number;
export const MODS_MANIFEST_CHANNELS: readonly string[];
export const EXTRA_FILE_POLICIES: readonly string[];
export const FILE_CATEGORIES: readonly string[];
export function normalizeManifestPath(value: unknown): string | null;

export function validateModsManifestContract(data: unknown):
  | { ok: true }
  | { ok: false; reason: string; detail?: string };
