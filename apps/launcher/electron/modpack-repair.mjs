import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function inspectTarget(gameRoot, relativePath) {
  const components = relativePath.split('/');
  let current = gameRoot;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return { state: 'unsafe' };
      if (index < components.length - 1 && !stat.isDirectory()) return { state: 'unsafe' };
      if (index === components.length - 1) return stat.isFile() ? { state: 'file', stat, target: current } : { state: 'unsafe' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing', target: current };
      throw error;
    }
  }
  return { state: 'unsafe' };
}

export async function inspectManifestForRepair(gameRoot, manifest, options = {}) {
  const hashFile = options.hashFile || sha256File;
  const healthy = [];
  const optionalMissing = [];
  const repairable = [];
  const manual = [];
  const unsafe = [];
  for (const file of manifest.files) {
    const observed = await inspectTarget(gameRoot, file.path);
    let reason = null;
    if (observed.state === 'unsafe') {
      unsafe.push({ path: file.path, reason: 'unsafe_destination' });
      continue;
    }
    if (observed.state === 'missing') {
      if (!file.required) { optionalMissing.push(file.path); continue; }
      reason = 'missing';
    } else if (observed.stat.size !== file.size) {
      reason = 'size';
    } else if ((await hashFile(observed.target)).toLocaleLowerCase('en-US') !== file.sha256) {
      reason = 'sha256';
    }
    if (!reason) { healthy.push(file.path); continue; }
    const candidate = { ...file, reason };
    if (file.downloadUrl) repairable.push(candidate);
    else manual.push(candidate);
  }
  return {
    healthy, optionalMissing, repairable, manual, unsafe,
    downloadBytes: repairable.reduce((sum, file) => sum + file.size, 0),
  };
}
