import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UpdateOperationCoordinator, throwIfUpdateCancelled } from './update-operation.mjs';

describe('cancelamento cooperativo do updater', () => {
  test('uma operação ativa bloqueia concorrência e finish antigo não encerra a nova', () => {
    const coordinator = new UpdateOperationCoordinator();
    const first = coordinator.begin('mods');
    assert.ok(first);
    assert.equal(coordinator.begin('client'), null);
    assert.equal(coordinator.finish(first), true);
    const second = coordinator.begin('client');
    assert.ok(second);
    assert.equal(coordinator.finish(first), false);
    assert.equal(coordinator.busy, true);
    assert.equal(coordinator.finish(second), true);
  });

  test('cancela antes do commit e propaga uma razão estável', () => {
    const coordinator = new UpdateOperationCoordinator();
    const operation = coordinator.begin('repair');
    coordinator.setPhase(operation, 'download');
    assert.deepEqual(coordinator.cancel(), { success: true, phase: 'download', kind: 'repair' });
    assert.throws(() => throwIfUpdateCancelled(operation.signal), /cancelada pelo jogador/);
    assert.equal(coordinator.cancel().alreadyRequested, true);
  });

  test('recusa cancelamento durante commit e sem operação', () => {
    const coordinator = new UpdateOperationCoordinator();
    assert.equal(coordinator.cancel().reason, 'no_active_operation');
    const operation = coordinator.begin('mods');
    coordinator.setPhase(operation, 'commit');
    assert.equal(coordinator.cancel().reason, 'commit_in_progress');
    assert.equal(operation.signal.aborted, false);
  });
});
