export class UpdateOperationCoordinator {
  constructor() {
    this.active = null;
    this.nextId = 1;
  }

  get busy() {
    return this.active !== null;
  }

  begin(kind) {
    if (this.active) return null;
    const operation = {
      id: this.nextId++,
      kind,
      phase: 'preparing',
      controller: new AbortController(),
    };
    this.active = operation;
    return { id: operation.id, kind, signal: operation.controller.signal };
  }

  setPhase(handle, phase) {
    if (!this.active || !handle || this.active.id !== handle.id) return false;
    this.active.phase = phase;
    return true;
  }

  finish(handle) {
    if (!this.active || !handle || this.active.id !== handle.id) return false;
    this.active = null;
    return true;
  }

  cancel() {
    if (!this.active) return { success: false, reason: 'no_active_operation' };
    if (this.active.phase === 'commit') return { success: false, reason: 'commit_in_progress' };
    if (this.active.controller.signal.aborted) return { success: true, alreadyRequested: true };
    this.active.controller.abort(new Error('Operação cancelada pelo jogador.'));
    return { success: true, phase: this.active.phase, kind: this.active.kind };
  }
}

export function throwIfUpdateCancelled(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada pelo jogador.');
}
