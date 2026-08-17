export type UpdatePhase = 'preparing' | 'download' | 'verify' | 'extract' | 'commit';
export type UpdateOperationHandle = { id: number; kind: string; signal: AbortSignal };

export class UpdateOperationCoordinator {
  readonly busy: boolean;
  begin(kind: string): UpdateOperationHandle | null;
  setPhase(handle: UpdateOperationHandle, phase: UpdatePhase): boolean;
  finish(handle: UpdateOperationHandle): boolean;
  cancel(): { success: boolean; reason?: string; alreadyRequested?: boolean; phase?: string; kind?: string };
}

export function throwIfUpdateCancelled(signal: AbortSignal): void;
