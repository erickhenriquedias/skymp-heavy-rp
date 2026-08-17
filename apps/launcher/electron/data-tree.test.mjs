import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findUnexpectedDataFiles, inspectDataTree } from './data-tree.mjs';

test('enumera todo arquivo regular da Data, independentemente da extensão', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-data-tree-'));
  try {
    await fs.mkdir(path.join(root, 'Platform', 'Plugins'), { recursive: true });
    await fs.mkdir(path.join(root, 'meshes'), { recursive: true });
    await fs.writeFile(path.join(root, 'Platform', 'Plugins', 'index.js'), 'js');
    await fs.writeFile(path.join(root, 'meshes', 'custom.nif'), 'nif');
    await fs.writeFile(path.join(root, 'extensionless'), 'asset');
    assert.deepEqual(inspectDataTree(root).files, [
      'Data/extensionless',
      'Data/meshes/custom.nif',
      'Data/Platform/Plugins/index.js',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('separa extras sem liberar nada além dos paths ignorados exatos', () => {
  const files = [
    'Data/HeavyRP.esp',
    'Data/Platform/Plugins/skymp5-client-settings.txt',
    'Data/Platform/Plugins/skymp5-client-settings.txt.bak',
    'Data/meshes/custom.nif',
  ];
  assert.deepEqual(findUnexpectedDataFiles(
    files,
    ['data/heavyrp.ESP', 'Data/meshes/custom.nif'],
    ['data/platform/plugins/SKYMP5-CLIENT-SETTINGS.TXT'],
  ), ['Data/Platform/Plugins/skymp5-client-settings.txt.bak']);
});
