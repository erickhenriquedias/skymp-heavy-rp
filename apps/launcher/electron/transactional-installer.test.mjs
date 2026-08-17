import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  InstallTransactionError,
  commitInstallTransaction,
  createInstallTransaction,
  recoverInterruptedInstall,
  rollbackLastInstall,
} from './transactional-installer.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-install-'));
  const gameRoot = path.join(root, 'game');
  await fs.mkdir(gameRoot);
  return { root, gameRoot };
}

async function writeStaged(transaction, relativePath, content) {
  const target = path.join(transaction.stagingRoot, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

describe('instalacao transacional do launcher', () => {
  test('so publica arquivos depois do staging completo e preserva backup N-1', async () => {
    const { root, gameRoot } = await fixture();
    try {
      await fs.mkdir(path.join(gameRoot, 'Data'));
      await fs.writeFile(path.join(gameRoot, 'Data', 'existing.txt'), 'old');
      const transaction = await createInstallTransaction(gameRoot);
      await writeStaged(transaction, 'Data/existing.txt', 'new');
      await writeStaged(transaction, 'Data/new.txt', 'created');

      const result = await commitInstallTransaction(transaction, [
        'Data/existing.txt',
        'Data/new.txt',
      ]);

      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'existing.txt'), 'utf8'), 'new');
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'new.txt'), 'utf8'), 'created');
      assert.equal(
        await fs.readFile(path.join(gameRoot, '.skyrp-updater', 'backups', result.transactionId, 'backup', 'Data', 'existing.txt'), 'utf8'),
        'old',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('remove apenas arquivo obsoleto declarado e rollback restaura versao anterior', async () => {
    const { root, gameRoot } = await fixture();
    try {
      await fs.mkdir(path.join(gameRoot, 'Data'));
      await fs.writeFile(path.join(gameRoot, 'Data', 'managed-old.txt'), 'managed');
      await fs.writeFile(path.join(gameRoot, 'Data', 'player-file.txt'), 'keep');
      const transaction = await createInstallTransaction(gameRoot);
      await writeStaged(transaction, 'Data/replacement.txt', 'replacement');
      await commitInstallTransaction(
        transaction,
        ['Data/replacement.txt'],
        ['Data/managed-old.txt'],
      );

      await assert.rejects(fs.stat(path.join(gameRoot, 'Data', 'managed-old.txt')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'player-file.txt'), 'utf8'), 'keep');

      const rollback = await rollbackLastInstall(gameRoot);
      assert.equal(rollback.rolledBack, true);
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'managed-old.txt'), 'utf8'), 'managed');
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'player-file.txt'), 'utf8'), 'keep');
      await assert.rejects(fs.stat(path.join(gameRoot, 'Data', 'replacement.txt')), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('segunda atualizacao substitui o ponteiro e mantem somente o backup N-1 atual', async () => {
    const { root, gameRoot } = await fixture();
    try {
      await fs.mkdir(path.join(gameRoot, 'Data'));
      await fs.writeFile(path.join(gameRoot, 'Data', 'version.txt'), 'v0');
      const first = await createInstallTransaction(gameRoot);
      await writeStaged(first, 'Data/version.txt', 'v1');
      const firstResult = await commitInstallTransaction(first, ['Data/version.txt']);

      const second = await createInstallTransaction(gameRoot);
      await writeStaged(second, 'Data/version.txt', 'v2');
      const secondResult = await commitInstallTransaction(second, ['Data/version.txt']);

      await assert.rejects(
        fs.stat(path.join(gameRoot, '.skyrp-updater', 'backups', firstResult.transactionId)),
        { code: 'ENOENT' },
      );
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'version.txt'), 'utf8'), 'v2');
      const rollback = await rollbackLastInstall(gameRoot);
      assert.equal(rollback.transactionId, secondResult.transactionId);
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'version.txt'), 'utf8'), 'v1');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('recupera journal interrompido antes de iniciar outra atualizacao', async () => {
    const { root, gameRoot } = await fixture();
    try {
      const activeRoot = path.join(gameRoot, '.skyrp-updater', 'active');
      await fs.mkdir(path.join(activeRoot, 'backup', 'Data'), { recursive: true });
      await fs.mkdir(path.join(gameRoot, 'Data'), { recursive: true });
      await fs.writeFile(path.join(activeRoot, 'backup', 'Data', 'changed.txt'), 'old');
      await fs.writeFile(path.join(gameRoot, 'Data', 'changed.txt'), 'half-new');
      await fs.writeFile(path.join(gameRoot, 'Data', 'created.txt'), 'half-created');
      await fs.writeFile(path.join(activeRoot, 'journal.json'), JSON.stringify({
        version: 1,
        transactionId: '1700000000000-aaaaaaaaaaaaaaaa',
        operations: [
          { relativePath: 'Data/changed.txt', hadOriginal: true, install: true },
          { relativePath: 'Data/created.txt', hadOriginal: false, install: true },
        ],
      }));

      const result = await recoverInterruptedInstall(gameRoot);
      assert.equal(result.recovered, true);
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'changed.txt'), 'utf8'), 'old');
      await assert.rejects(fs.stat(path.join(gameRoot, 'Data', 'created.txt')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(activeRoot), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('queda depois da fase committed finaliza em vez de desfazer arquivos publicados', async () => {
    const { root, gameRoot } = await fixture();
    try {
      const transactionId = '1700000000001-bbbbbbbbbbbbbbbb';
      const activeRoot = path.join(gameRoot, '.skyrp-updater', 'active');
      await fs.mkdir(path.join(activeRoot, 'backup', 'Data'), { recursive: true });
      await fs.mkdir(path.join(activeRoot, 'staging'), { recursive: true });
      await fs.mkdir(path.join(gameRoot, 'Data'), { recursive: true });
      await fs.writeFile(path.join(activeRoot, 'backup', 'Data', 'changed.txt'), 'old');
      await fs.writeFile(path.join(gameRoot, 'Data', 'changed.txt'), 'new');
      await fs.writeFile(path.join(activeRoot, 'owner.json'), JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        transactionId,
      }));
      await fs.writeFile(path.join(activeRoot, 'journal.json'), JSON.stringify({
        version: 1,
        transactionId,
        phase: 'committed',
        previousTransactionId: null,
        operations: [{ relativePath: 'Data/changed.txt', hadOriginal: true, install: true }],
      }));

      const result = await recoverInterruptedInstall(gameRoot);
      assert.equal(result.finalized, true);
      assert.equal(await fs.readFile(path.join(gameRoot, 'Data', 'changed.txt'), 'utf8'), 'new');
      const latest = JSON.parse(await fs.readFile(path.join(gameRoot, '.skyrp-updater', 'latest.json'), 'utf8'));
      assert.equal(latest.transactionId, transactionId);
      assert.equal(
        await fs.readFile(path.join(gameRoot, '.skyrp-updater', 'backups', transactionId, 'backup', 'Data', 'changed.txt'), 'utf8'),
        'old',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('recusa pacote que tenta escrever nos metadados do atualizador', async () => {
    const { root, gameRoot } = await fixture();
    try {
      const transaction = await createInstallTransaction(gameRoot);
      await assert.rejects(
        commitInstallTransaction(transaction, ['.skyrp-updater/latest.json']),
        error => error instanceof InstallTransactionError && error.code === 'INSTALL_RESERVED_PATH',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('lock interprocesso recusa uma segunda transacao ativa', async () => {
    const { root, gameRoot } = await fixture();
    try {
      const activeRoot = path.join(gameRoot, '.skyrp-updater', 'active');
      await fs.mkdir(activeRoot, { recursive: true });
      await fs.writeFile(path.join(activeRoot, 'owner.json'), JSON.stringify({
        version: 1,
        pid: process.pid,
        transactionId: 'other-live-process',
      }));
      await assert.rejects(
        createInstallTransaction(gameRoot),
        error => error instanceof InstallTransactionError && error.code === 'INSTALL_IN_PROGRESS',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('recusa destino que atravessa link e nao escreve fora do jogo', async () => {
    const { root, gameRoot } = await fixture();
    try {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(gameRoot, 'Data'), process.platform === 'win32' ? 'junction' : 'dir');
      const transaction = await createInstallTransaction(gameRoot);
      await writeStaged(transaction, 'Data/escape.txt', 'blocked');
      await assert.rejects(
        commitInstallTransaction(transaction, ['Data/escape.txt']),
        error => error instanceof InstallTransactionError && error.code === 'INSTALL_DESTINATION_LINK',
      );
      await assert.rejects(fs.stat(path.join(outside, 'escape.txt')), { code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
