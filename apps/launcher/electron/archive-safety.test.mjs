import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ArchiveSafetyError,
  inspectArchiveForExtraction,
  validateArchiveEntries,
} from './archive-safety.mjs';

function entry(name, overrides = {}) {
  return {
    name,
    length: 32,
    compressedLength: 16,
    externalAttributes: 0,
    ...overrides,
  };
}

function rejectsWithCode(entries, code, limits) {
  assert.throws(
    () => validateArchiveEntries(entries, limits),
    error => error instanceof ArchiveSafetyError && error.code === code,
  );
}

describe('segurança da extração do modpack', () => {
  test('aceita somente caminhos relativos normais', () => {
    const result = validateArchiveEntries([
      entry('Data/SKSE/Plugins/SkyRPNative.dll'),
      entry('Data/meshes/actors/character/facegendata/file.nif'),
    ]);
    assert.equal(result.entryCount, 2);
    assert.equal(result.totalBytes, 64);
  });

  test('recusa travessia com barras normais ou invertidas', () => {
    rejectsWithCode([entry('../secrets.cfg')], 'ARCHIVE_PATH_TRAVERSAL');
    rejectsWithCode([entry('Data\\..\\..\\outside.dll')], 'ARCHIVE_PATH_TRAVERSAL');
  });

  test('recusa caminhos absolutos, UNC e com drive', () => {
    rejectsWithCode([entry('/Windows/System32/file.dll')], 'ARCHIVE_ABSOLUTE_PATH');
    rejectsWithCode([entry('C:/Windows/file.dll')], 'ARCHIVE_ABSOLUTE_PATH');
    rejectsWithCode([entry('\\\\server\\share\\file.dll')], 'ARCHIVE_ABSOLUTE_PATH');
  });

  test('recusa ADS e nomes especiais do Windows', () => {
    rejectsWithCode([entry('Data/file.txt:payload')], 'ARCHIVE_WINDOWS_PATH');
    rejectsWithCode([entry('Data/CON.txt')], 'ARCHIVE_WINDOWS_PATH');
    rejectsWithCode([entry('Data/file.dll ')], 'ARCHIVE_WINDOWS_PATH');
  });

  test('recusa colisão que o Windows trataria como o mesmo destino', () => {
    rejectsWithCode([
      entry('Data/Example.esp'),
      entry('data/example.esp'),
    ], 'ARCHIVE_PATH_COLLISION');
  });

  test('recusa symlink ou junction codificado no ZIP', () => {
    const unixSymlink = 0xa1ff * 0x10000;
    rejectsWithCode([
      entry('Data/link', { externalAttributes: unixSymlink }),
    ], 'ARCHIVE_LINK_ENTRY');
  });

  test('recusa quantidade e tamanho descompactado acima da política', () => {
    rejectsWithCode([entry('a'), entry('b')], 'ARCHIVE_ENTRY_LIMIT', { maxEntries: 1 });
    rejectsWithCode([
      entry('large.bsa', { length: 101 }),
    ], 'ARCHIVE_SIZE_LIMIT', { maxEntryBytes: 100 });
    rejectsWithCode([
      entry('a.bsa', { length: 60 }),
      entry('b.bsa', { length: 60 }),
    ], 'ARCHIVE_SIZE_LIMIT', { maxTotalBytes: 100 });
  });

  test('recusa diretório vazio ou metadados de tamanho inválidos', () => {
    rejectsWithCode([], 'ARCHIVE_ENTRY_LIMIT');
    rejectsWithCode([
      entry('Data/file.bsa', { compressedLength: -1 }),
    ], 'ARCHIVE_INVALID_DIRECTORY');
  });

  test('inspeciona um ZIP real antes da extração', { skip: process.platform !== 'win32' }, async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-archive-test-'));
    const source = path.join(temporaryRoot, 'source');
    const destination = path.join(temporaryRoot, 'destination');
    const archive = path.join(temporaryRoot, 'package.zip');
    try {
      await fs.mkdir(path.join(source, 'Data'), { recursive: true });
      await fs.mkdir(destination);
      await fs.writeFile(path.join(source, 'Data', 'safe.txt'), 'safe');
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SKYRP_TEST_SOURCE, $env:SKYRP_TEST_ARCHIVE)",
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SKYRP_TEST_SOURCE: source,
            SKYRP_TEST_ARCHIVE: archive,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const inspection = await inspectArchiveForExtraction(archive, destination);
      assert.ok(inspection.normalizedNames.includes('Data/safe.txt'));
      assert.equal(inspection.entryCount >= 1, true);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('recusa um ZIP real com entrada de travessia antes de escrever', { skip: process.platform !== 'win32' }, async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-archive-hostile-'));
    const destination = path.join(temporaryRoot, 'destination');
    const archive = path.join(temporaryRoot, 'hostile.zip');
    try {
      await fs.mkdir(destination);
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Add-Type -AssemblyName System.IO.Compression; $stream = [IO.File]::Open($env:SKYRP_TEST_ARCHIVE, [IO.FileMode]::Create); $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create); $null = $zip.CreateEntry('../outside.txt'); $zip.Dispose(); $stream.Dispose()",
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SKYRP_TEST_ARCHIVE: archive },
        },
      );
      assert.equal(result.status, 0, result.stderr);

      await assert.rejects(
        inspectArchiveForExtraction(archive, destination),
        error => error instanceof ArchiveSafetyError && error.code === 'ARCHIVE_PATH_TRAVERSAL',
      );
      await assert.rejects(fs.stat(path.join(temporaryRoot, 'outside.txt')), { code: 'ENOENT' });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
