import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function hashFileStream(filePath, algorithm, streamFactory = createReadStream) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    let stream;
    try {
      stream = streamFactory(filePath);
    } catch (error) {
      reject(error);
      return;
    }
    stream.on('data', chunk => { hash.update(chunk); });
    stream.on('end', () => { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}

export function md5File(filePath, streamFactory) {
  return hashFileStream(filePath, 'md5', streamFactory);
}

