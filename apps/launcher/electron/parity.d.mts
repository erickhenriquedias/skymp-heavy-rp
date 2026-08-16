/**
 * Tipos de `parity.mjs`.
 *
 * O módulo é JS puro para que `node --test` rode sem passo de build; esta
 * declaração é o que mantém o `main.ts` typechecked ao importá-lo.
 */

export interface PluginHeader {
  masters: string[];
  isMaster: boolean;
  isLight: boolean;
  error?: string;
}

export interface PluginEntry {
  name: string;
  enabled: boolean;
}

export interface ServerMod {
  filename: string;
  hash: string;
}

export function parsePluginsTxt(content: string): PluginEntry[];

export function parsePluginHeader(buffer: Buffer | null | undefined): PluginHeader;

export function compareMods(params: {
  serverMods: ServerMod[] | null | undefined;
  localFiles: string[];
  hashOf: (filename: string) => string;
}): { success: boolean; error?: string; problems: string[] };

export function analyzePlugins(params: {
  localPlugins: string[];
  serverLoadOrder: string[] | null | undefined;
  enabledPlugins?: string[];
  readHeader: (name: string) => PluginHeader;
}): { ok: boolean; problems: string[]; plugins: Array<{ name: string } & PluginHeader> };

export function parseCccTxt(content: string | null | undefined): string[];

/**
 * `effective` são os plugins de Creation Club que o jogo realmente carrega:
 * listados no `Skyrim.ccc` **e** presentes em `Data/`.
 */
export function analyzeCreationClub(params: {
  cccEntries: string[] | null | undefined;
  localPlugins: string[] | null | undefined;
  serverLoadOrder: string[] | null | undefined;
}): { ok: boolean; problems: string[]; effective: string[] };
