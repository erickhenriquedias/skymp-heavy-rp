import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { md5File } from './file-hash.mjs';

describe('hash de arquivos grandes por stream', () => {
  test('calcula o MD5 esperado de um arquivo real', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-hash-'));
    const filePath = path.join(temporaryRoot, 'example.bsa');
    try {
      await fs.writeFile(filePath, 'Skyrim Heavy RP');
      assert.equal(await md5File(filePath), '4e2addfe105fbe7d8b88d208cab8c4e1');
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('processa vários chunks sem precisar de um Buffer único', async () => {
    const chunks = [Buffer.from('Skyrim '), Buffer.from('Heavy '), Buffer.from('RP')];
    let requestedPath = null;
    const digest = await md5File('virtual-large.bsa', filePath => {
      requestedPath = filePath;
      return Readable.from(chunks);
    });
    assert.equal(requestedPath, 'virtual-large.bsa');
    assert.equal(digest, '4e2addfe105fbe7d8b88d208cab8c4e1');
  });

  test('propaga erro de leitura sem produzir hash parcial', async () => {
    await assert.rejects(
      md5File('missing.bsa', () => {
        const stream = new Readable({ read() {} });
        queueMicrotask(() => stream.destroy(new Error('disk failure')));
        return stream;
      }),
      /disk failure/,
    );
  });
});
