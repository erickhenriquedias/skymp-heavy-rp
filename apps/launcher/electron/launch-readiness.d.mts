export type RepairAction = 'retry' | 'settings' | 'update-client' | 'update-mods' | 'repair-mods';

export const PREPARATION_TTL_MS: number;
export function classifyUpdateReadiness(client: any, mods: any): any;
export function classifyParityReadiness(verification: any, analysis: any): any;

export class LaunchPreparationStore {
  constructor(options?: { ttlMs?: number; randomToken?: () => string });
  issue(context: { gamePath: string; discordId: string; now?: number }): { token: string; expiresAt: number };
  validate(token: string, context: { gamePath: string; discordId: string; now?: number }): { ok: boolean; reason?: string };
  consume(token: string, context: { gamePath: string; discordId: string; now?: number }): { ok: boolean; reason?: string };
  clear(): void;
}
