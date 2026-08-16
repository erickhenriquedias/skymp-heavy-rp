import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 200_000,
  maxEntryBytes: 64 * 1024 ** 3,
  maxTotalBytes: 512 * 1024 ** 3,
  maxPathLength: 1024,
});

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class ArchiveSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveSafetyError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new ArchiveSafetyError(code, message);
}

function normalizedEntryName(rawName, maxPathLength) {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    reject('ARCHIVE_INVALID_PATH', 'O pacote contém uma entrada sem nome.');
  }
  const hasControlCharacter = Array.from(rawName).some(character => character.charCodeAt(0) < 32);
  if (rawName.length > maxPathLength || hasControlCharacter) {
    reject('ARCHIVE_INVALID_PATH', 'O pacote contém um caminho inválido ou excessivamente longo.');
  }

  const name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) {
    reject('ARCHIVE_ABSOLUTE_PATH', `O pacote tentou usar caminho absoluto: ${rawName}`);
  }

  const components = name.split('/').filter((component, index, all) => {
    return component.length > 0 || index < all.length - 1;
  });
  if (components.length === 0) {
    reject('ARCHIVE_INVALID_PATH', 'O pacote contém uma entrada sem destino.');
  }

  for (const component of components) {
    if (!component || component === '.' || component === '..') {
      reject('ARCHIVE_PATH_TRAVERSAL', `O pacote tentou sair da pasta do jogo: ${rawName}`);
    }
    if (component.includes(':') || WINDOWS_RESERVED_NAME.test(component)) {
      reject('ARCHIVE_WINDOWS_PATH', `O pacote contém nome proibido no Windows: ${rawName}`);
    }
    if (/[. ]$/.test(component)) {
      reject('ARCHIVE_WINDOWS_PATH', `O pacote contém caminho ambíguo no Windows: ${rawName}`);
    }
  }

  return components.join('/');
}

function isUnsafeEntryType(externalAttributes) {
  const attributes = Number(externalAttributes);
  if (!Number.isSafeInteger(attributes) || attributes < 0) return false;
  const unixMode = Math.floor(attributes / 0x10000) & 0xffff;
  const unixFileType = unixMode & 0xf000;
  const dosAttributes = attributes & 0xffff;
  const isUnixRegularOrDirectory = unixFileType === 0 || unixFileType === 0x8000 || unixFileType === 0x4000;
  return !isUnixRegularOrDirectory || (dosAttributes & 0x0400) !== 0;
}

export function validateArchiveEntries(entries, limits = {}) {
  if (!Array.isArray(entries)) {
    reject('ARCHIVE_INVALID_DIRECTORY', 'Não foi possível ler o diretório do pacote.');
  }

  const policy = { ...DEFAULT_LIMITS, ...limits };
  if (entries.length === 0 || entries.length > policy.maxEntries) {
    reject('ARCHIVE_ENTRY_LIMIT', 'O pacote está vazio ou excede o limite de arquivos.');
  }

  const seen = new Set();
  const normalizedNames = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const name = normalizedEntryName(entry?.name, policy.maxPathLength);
    const collisionKey = name.toLocaleLowerCase('en-US');
    if (seen.has(collisionKey)) {
      reject('ARCHIVE_PATH_COLLISION', `O pacote contém destinos duplicados: ${entry.name}`);
    }
    seen.add(collisionKey);

    if (isUnsafeEntryType(entry?.externalAttributes)) {
      reject('ARCHIVE_LINK_ENTRY', `O pacote contém link, junction ou entrada especial: ${entry.name}`);
    }

    const length = Number(entry?.length);
    const compressedLength = Number(entry?.compressedLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > policy.maxEntryBytes) {
      reject('ARCHIVE_SIZE_LIMIT', `Entrada do pacote excede o limite: ${entry.name}`);
    }
    if (!Number.isSafeInteger(compressedLength) || compressedLength < 0) {
      reject('ARCHIVE_INVALID_DIRECTORY', `Tamanho compactado inválido: ${entry.name}`);
    }

    totalBytes += length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.maxTotalBytes) {
      reject('ARCHIVE_SIZE_LIMIT', 'O pacote excede o limite total descompactado.');
    }
    normalizedNames.push(name);
  }

  return { normalizedNames, totalBytes, entryCount: entries.length };
}

function inspectWithPowerShell(zipPath) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:SKYRP_ARCHIVE_PATH)
try {
  $entries = @($archive.Entries | ForEach-Object {
    [pscustomobject]@{
      name = $_.FullName
      length = [int64]$_.Length
      compressedLength = [int64]$_.CompressedLength
      externalAttributes = [int64]([uint32]$_.ExternalAttributes)
    }
  })
  ConvertTo-Json -Compress -Depth 3 -InputObject $entries
} finally {
  $archive.Dispose()
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve, rejectPromise) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        env: { ...process.env, SKYRP_ARCHIVE_PATH: zipPath },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (code !== 0) {
        rejectPromise(new ArchiveSafetyError(
          'ARCHIVE_INSPECTION_FAILED',
          stderr.trim() || `A inspeção do pacote saiu com código ${code}.`,
        ));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        rejectPromise(new ArchiveSafetyError(
          'ARCHIVE_INSPECTION_FAILED',
          'A inspeção do pacote retornou um diretório inválido.',
        ));
      }
    });
  });
}

async function assertNoExistingLinks(destinationRoot, normalizedNames) {
  const root = await fs.realpath(destinationRoot);
  const checked = new Set();

  for (const name of normalizedNames) {
    const components = name.split('/');
    let current = root;
    for (const component of components) {
      current = path.join(current, component);
      const key = current.toLocaleLowerCase('en-US');
      if (checked.has(key)) continue;
      checked.add(key);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          reject('ARCHIVE_DESTINATION_LINK', `O destino atravessa um link existente: ${name}`);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

export async function inspectArchiveForExtraction(zipPath, destinationRoot, limits) {
  const entries = await inspectWithPowerShell(zipPath);
  const validation = validateArchiveEntries(entries, limits);
  await assertNoExistingLinks(destinationRoot, validation.normalizedNames);
  return validation;
}
