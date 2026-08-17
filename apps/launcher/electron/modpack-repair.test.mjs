import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectManifestForRepair } from './modpack-repair.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('planeja somente arquivos ausentes/corrompidos que possuem origem autorizada', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modpack-repair-'));
  try {
    await fs.mkdir(path.join(root, 'Data'));
    await fs.writeFile(path.join(root, 'Data', 'good.esp'), 'good');
    await fs.writeFile(path.join(root, 'Data', 'broken.bsa'), 'bad');
    const manifest = { files: [
      { path: 'Data/good.esp', size: 4, sha256: digest('good'), required: true, category: 'plugin' },
      { path: 'Data/broken.bsa', size: 5, sha256: digest('fixed'), required: true, category: 'archive', downloadUrl: 'https://github.com/a/b/releases/fixed' },
      { path: 'Data/manual.esp', size: 1, sha256: digest('x'), required: true, category: 'plugin' },
      { path: 'Data/optional.ini', size: 1, sha256: digest('x'), required: false, category: 'config' },
    ] };
    const plan = await inspectManifestForRepair(root, manifest);
    assert.deepEqual(plan.healthy, ['Data/good.esp']);
    assert.equal(plan.repairable[0].path, 'Data/broken.bsa');
    assert.equal(plan.manual[0].path, 'Data/manual.esp');
    assert.deepEqual(plan.optionalMissing, ['Data/optional.ini']);
    assert.equal(plan.downloadBytes, 5);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('recusa destino que atravessa symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modpack-repair-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modpack-outside-'));
  try {
    await fs.mkdir(path.join(root, 'Data'));
    try { await fs.symlink(outside, path.join(root, 'Data', 'linked'), 'junction'); }
    catch { return; }
    const plan = await inspectManifestForRepair(root, { files: [{
      path: 'Data/linked/x.dll', size: 1, sha256: digest('x'), required: true, category: 'binary', downloadUrl: 'https://github.com/a/b/releases/x',
    }] });
    assert.deepEqual(plan.unsafe, [{ path: 'Data/linked/x.dll', reason: 'unsafe_destination' }]);
    assert.equal(plan.repairable.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
