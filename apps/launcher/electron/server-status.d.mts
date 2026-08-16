export type PublicServerState = 'online' | 'full' | 'starting' | 'maintenance' | 'offline';

export interface PublicServerStatus {
  state: PublicServerState;
  players: number;
  capacity: number;
  queue: number;
  message: string | null;
}

export function offlineServerStatus(): PublicServerStatus;
export function normalizeServerStatus(payload: unknown): PublicServerStatus;
