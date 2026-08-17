import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const METADATA_DIRECTORY = '.skyrp-updater';
const ACTIVE_DIRECTORY = 'active';
const BACKUPS_DIRECTORY = 'backups';
const JOURNAL_FILENAME = 'journal.json';
const OWNER_FILENAME = 'owner.json';

export class InstallTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallTransactionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new InstallTransactionError(code, message);
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('INSTALL_INVALID_PATH', 'A transacao contem um caminho invalido.');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    fail('INSTALL_INVALID_PATH', `Caminho absoluto recusado: ${value}`);
  }
  const components = normalized.split('/');
  if (components.some(component => !component || component === '.' || component === '..')) {
    fail('INSTALL_INVALID_PATH', `Caminho fora da instalacao recusado: ${value}`);
  }
  if (components[0].toLocaleLowerCase('en-US') === METADATA_DIRECTORY) {
    fail('INSTALL_RESERVED_PATH', `O pacote tentou modificar metadados do atualizador: ${value}`);
  }
  return components.join('/');
}

function resolveInside(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`.toLocaleLowerCase('en-US');
  if (!resolved.toLocaleLowerCase('en-US').startsWith(prefix)) {
    fail('INSTALL_INVALID_PATH', `Destino fora da instalacao recusado: ${relativePath}`);
  }
  return resolved;
}

async function pathState(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      fail('INSTALL_DESTINATION_LINK', `Link simbolico recusado durante a instalacao: ${target}`);
    }
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectoryOrMissing(target, label) {
  const state = await pathState(target);
  if (state && !state.isDirectory()) {
    fail('INSTALL_DESTINATION_TYPE', `${label} nao e um diretorio valido.`);
  }
}

async function assertNoLinkedAncestors(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  let current = path.resolve(root);
  for (const component of normalized.split('/')) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        fail('INSTALL_DESTINATION_LINK', `O destino atravessa um link existente: ${relativePath}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function removeEmptyParents(start, stop) {
  let current = path.dirname(start);
  const boundary = path.resolve(stop).toLocaleLowerCase('en-US');
  while (current.toLocaleLowerCase('en-US') !== boundary) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return;
      throw error;
    }
    current = path.dirname(current);
  }
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.tmp`;
  await pathState(target);
  await pathState(temporary);
  await fs.rm(temporary, { force: true });
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

async function readJournal(journalPath) {
  let journal;
  try {
    journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('INSTALL_JOURNAL_INVALID', 'O journal de atualizacao esta corrompido. Reparacao manual necessaria.');
  }
  if (
    journal?.version !== 1
    || !Array.isArray(journal.operations)
    || typeof journal.transactionId !== 'string'
    || !/^[0-9]+-[a-f0-9]{16}$/.test(journal.transactionId)
    || (journal.previousTransactionId != null && !/^[0-9]+-[a-f0-9]{16}$/.test(journal.previousTransactionId))
  ) {
    fail('INSTALL_JOURNAL_INVALID', 'O journal de atualizacao possui formato desconhecido.');
  }
  return journal;
}

async function latestTransactionId(metadataRoot) {
  try {
    const latest = JSON.parse(await fs.readFile(path.join(metadataRoot, 'latest.json'), 'utf8'));
    return latest?.version === 1 && typeof latest.transactionId === 'string' && /^[0-9]+-[a-f0-9]{16}$/.test(latest.transactionId)
      ? latest.transactionId
      : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function activeOwner(activeRoot) {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(activeRoot, OWNER_FILENAME), 'utf8'));
    return Number.isInteger(owner?.pid) && typeof owner?.transactionId === 'string' ? owner : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function rollbackJournal(gameRoot, backupRoot, journal) {
  for (const operation of [...journal.operations].reverse()) {
    const relativePath = normalizeRelativePath(operation.relativePath);
    await assertNoLinkedAncestors(gameRoot, relativePath);
    const destination = resolveInside(gameRoot, relativePath);
    const backup = resolveInside(backupRoot, relativePath);
    const backupState = await pathState(backup);

    if (backupState) {
      const destinationState = await pathState(destination);
      if (destinationState) await fs.rm(destination, { recursive: destinationState.isDirectory(), force: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(backup, destination);
      continue;
    }

    if (!operation.hadOriginal) {
      const destinationState = await pathState(destination);
      if (destinationState) {
        await fs.rm(destination, { recursive: destinationState.isDirectory(), force: true });
        await removeEmptyParents(destination, gameRoot);
      }
    }
  }
}

async function finalizeCommittedInstall(gameRoot, activeRoot, journal) {
  const metadataRoot = path.join(gameRoot, METADATA_DIRECTORY);
  const backupsRoot = path.join(metadataRoot, BACKUPS_DIRECTORY);
  const completedRoot = path.join(backupsRoot, journal.transactionId);
  await assertDirectoryOrMissing(backupsRoot, 'A pasta de backups');
  await fs.mkdir(backupsRoot, { recursive: true });
  await writeJsonAtomic(path.join(metadataRoot, 'latest.json'), {
    version: 1,
    transactionId: journal.transactionId,
  });
  await fs.rm(path.join(activeRoot, 'staging'), { recursive: true, force: true });
  await fs.rename(activeRoot, completedRoot);
  if (journal.previousTransactionId && journal.previousTransactionId !== journal.transactionId) {
    await fs.rm(path.join(backupsRoot, journal.previousTransactionId), { recursive: true, force: true });
  }
}

export async function recoverInterruptedInstall(gameRoot) {
  const realGameRoot = await fs.realpath(gameRoot);
  const activeRoot = path.join(realGameRoot, METADATA_DIRECTORY, ACTIVE_DIRECTORY);
  await assertDirectoryOrMissing(path.join(realGameRoot, METADATA_DIRECTORY), 'A pasta de metadados');
  await assertDirectoryOrMissing(activeRoot, 'A transacao ativa');
  const owner = await activeOwner(activeRoot);
  if (owner && processIsAlive(owner.pid)) {
    fail('INSTALL_IN_PROGRESS', 'Outro processo do launcher esta atualizando esta instalacao.');
  }
  const journalPath = path.join(activeRoot, JOURNAL_FILENAME);
  const journal = await readJournal(journalPath);
  if (!journal) {
    try {
      await fs.rm(activeRoot, { recursive: true, force: true });
      return { recovered: Boolean(owner), transactionId: owner?.transactionId };
    } catch (error) {
      if (error?.code === 'ENOENT') return { recovered: false };
      throw error;
    }
  }

  if (journal.phase === 'committed') {
    await finalizeCommittedInstall(realGameRoot, activeRoot, journal);
    return { recovered: true, transactionId: journal.transactionId, finalized: true };
  }

  await rollbackJournal(realGameRoot, path.join(activeRoot, 'backup'), journal);
  await fs.rm(activeRoot, { recursive: true, force: true });
  return { recovered: true, transactionId: journal.transactionId };
}

export async function createInstallTransaction(gameRoot) {
  const realGameRoot = await fs.realpath(gameRoot);
  await assertDirectoryOrMissing(path.join(realGameRoot, METADATA_DIRECTORY), 'A pasta de metadados');
  await recoverInterruptedInstall(realGameRoot);
  const metadataRoot = path.join(realGameRoot, METADATA_DIRECTORY);
  const activeRoot = path.join(metadataRoot, ACTIVE_DIRECTORY);
  await fs.mkdir(metadataRoot, { recursive: true });
  try {
    await fs.mkdir(activeRoot);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('INSTALL_IN_PROGRESS', 'Outro processo do launcher iniciou uma atualizacao nesta instalacao.');
    }
    throw error;
  }
  const transactionId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  await fs.writeFile(path.join(activeRoot, OWNER_FILENAME), `${JSON.stringify({
    version: 1,
    pid: process.pid,
    transactionId,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx' });
  await fs.mkdir(path.join(activeRoot, 'staging'));
  await fs.mkdir(path.join(activeRoot, 'backup'), { recursive: true });
  return {
    gameRoot: realGameRoot,
    transactionId,
    activeRoot,
    stagingRoot: path.join(activeRoot, 'staging'),
  };
}

export async function discardInstallTransaction(transaction) {
  const gameRoot = await fs.realpath(transaction.gameRoot);
  const expectedActiveRoot = path.join(gameRoot, METADATA_DIRECTORY, ACTIVE_DIRECTORY);
  if (path.resolve(transaction.activeRoot).toLocaleLowerCase('en-US') !== expectedActiveRoot.toLocaleLowerCase('en-US')) {
    fail('INSTALL_TRANSACTION_SCOPE', 'A transacao nao pertence a esta instalacao.');
  }
  await assertDirectoryOrMissing(expectedActiveRoot, 'A transacao ativa');
  const owner = await activeOwner(expectedActiveRoot);
  if (owner && owner.transactionId !== transaction.transactionId) {
    fail('INSTALL_TRANSACTION_SCOPE', 'A transacao ativa pertence a outro processo.');
  }
  const journal = await readJournal(path.join(expectedActiveRoot, JOURNAL_FILENAME));
  if (journal?.phase === 'committed') {
    fail('INSTALL_ALREADY_COMMITTED', 'A transacao ja foi aplicada e precisa ser finalizada, nao descartada.');
  }
  await fs.rm(expectedActiveRoot, { recursive: true, force: true });
}

export async function commitInstallTransaction(transaction, installFiles, obsoleteFiles = []) {
  const gameRoot = await fs.realpath(transaction.gameRoot);
  const metadataRoot = path.join(gameRoot, METADATA_DIRECTORY);
  const expectedActiveRoot = path.join(gameRoot, METADATA_DIRECTORY, ACTIVE_DIRECTORY);
  if (path.resolve(transaction.activeRoot).toLocaleLowerCase('en-US') !== expectedActiveRoot.toLocaleLowerCase('en-US')) {
    fail('INSTALL_TRANSACTION_SCOPE', 'A transacao nao pertence a esta instalacao.');
  }
  await assertDirectoryOrMissing(expectedActiveRoot, 'A transacao ativa');
  const owner = await activeOwner(expectedActiveRoot);
  if (!owner || owner.transactionId !== transaction.transactionId || owner.pid !== process.pid) {
    fail('INSTALL_TRANSACTION_SCOPE', 'O lock desta transacao nao esta mais ativo.');
  }
  await assertDirectoryOrMissing(metadataRoot, 'A pasta de metadados');
  await assertDirectoryOrMissing(path.join(metadataRoot, BACKUPS_DIRECTORY), 'A pasta de backups');

  const installSet = new Set(installFiles.map(normalizeRelativePath));
  const obsoleteSet = new Set(obsoleteFiles.map(normalizeRelativePath));
  for (const relativePath of installSet) obsoleteSet.delete(relativePath);
  const operations = [];

  for (const relativePath of [...installSet, ...obsoleteSet].sort()) {
    await assertNoLinkedAncestors(gameRoot, relativePath);
    const destination = resolveInside(gameRoot, relativePath);
    const source = installSet.has(relativePath)
      ? resolveInside(transaction.stagingRoot, relativePath)
      : null;
    const destinationState = await pathState(destination);
    if (source) {
      const sourceState = await pathState(source);
      if (!sourceState?.isFile()) {
        fail('INSTALL_STAGED_FILE_MISSING', `Arquivo esperado nao existe no staging: ${relativePath}`);
      }
    }
    if (destinationState?.isDirectory()) {
      fail('INSTALL_DESTINATION_TYPE', `O destino de arquivo e um diretorio: ${relativePath}`);
    }
    operations.push({ relativePath, hadOriginal: Boolean(destinationState), install: Boolean(source) });
  }

  const previousTransactionId = await latestTransactionId(metadataRoot);
  const journal = {
    version: 1,
    transactionId: transaction.transactionId,
    createdAt: new Date().toISOString(),
    phase: 'prepared',
    previousTransactionId,
    operations,
  };
  const journalPath = path.join(transaction.activeRoot, JOURNAL_FILENAME);
  await writeJsonAtomic(journalPath, journal);

  try {
    for (const operation of operations) {
      const destination = resolveInside(gameRoot, operation.relativePath);
      const backup = resolveInside(path.join(transaction.activeRoot, 'backup'), operation.relativePath);
      if (operation.hadOriginal) {
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(destination, backup);
      }
      if (operation.install) {
        const source = resolveInside(transaction.stagingRoot, operation.relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
      }
    }
  } catch (error) {
    await rollbackJournal(gameRoot, path.join(transaction.activeRoot, 'backup'), journal);
    await fs.rm(transaction.activeRoot, { recursive: true, force: true });
    throw error;
  }

  journal.phase = 'committed';
  await writeJsonAtomic(journalPath, journal);
  await finalizeCommittedInstall(gameRoot, transaction.activeRoot, journal);
  return { transactionId: transaction.transactionId, filesChanged: operations.length };
}

export async function rollbackLastInstall(gameRoot) {
  const realGameRoot = await fs.realpath(gameRoot);
  const metadataRoot = path.join(realGameRoot, METADATA_DIRECTORY);
  await assertDirectoryOrMissing(metadataRoot, 'A pasta de metadados');
  await assertDirectoryOrMissing(path.join(metadataRoot, BACKUPS_DIRECTORY), 'A pasta de backups');
  let latest;
  try {
    latest = JSON.parse(await fs.readFile(path.join(metadataRoot, 'latest.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { rolledBack: false };
    fail('INSTALL_JOURNAL_INVALID', 'O ponteiro de rollback esta corrompido.');
  }
  if (latest?.version !== 1 || typeof latest.transactionId !== 'string' || !/^[0-9]+-[a-f0-9]{16}$/.test(latest.transactionId)) {
    fail('INSTALL_JOURNAL_INVALID', 'O ponteiro de rollback possui formato invalido.');
  }
  const completedRoot = path.join(metadataRoot, BACKUPS_DIRECTORY, latest.transactionId);
  const journal = await readJournal(path.join(completedRoot, JOURNAL_FILENAME));
  if (!journal || journal.transactionId !== latest.transactionId) {
    fail('INSTALL_JOURNAL_INVALID', 'O backup da ultima atualizacao esta incompleto.');
  }
  await rollbackJournal(realGameRoot, path.join(completedRoot, 'backup'), journal);
  await fs.rm(path.join(metadataRoot, 'latest.json'), { force: true });
  await fs.writeFile(path.join(completedRoot, 'rolled-back'), `${new Date().toISOString()}\n`, { flag: 'wx' });
  return { rolledBack: true, transactionId: latest.transactionId };
}
