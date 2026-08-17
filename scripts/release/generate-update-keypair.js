'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { KEY_ID_PATTERN } = require('../../skymp/packages/signed-update-manifest.js');

function generateKeypair(keyId, privateOutput) {
  if (!KEY_ID_PATTERN.test(keyId || '')) throw new Error('keyId invalido: use 1-64 caracteres [a-z0-9._-].');
  const outputPath = path.resolve(privateOutput || '');
  if (!privateOutput) throw new Error('Informe --private-out fora do repositorio ou com sufixo .update-signing.pk8.base64.');
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${privateKey}\n`, { flag: 'wx', mode: 0o600 });
  return { keyId, outputPath, publicKey };
}

function main(argv = process.argv.slice(2)) {
  const keyIndex = argv.indexOf('--key-id');
  const outputIndex = argv.indexOf('--private-out');
  if (keyIndex < 0 || outputIndex < 0 || !argv[keyIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error('Uso: node scripts/release/generate-update-keypair.js --key-id release-2026 --private-out caminho.update-signing.pk8.base64');
  }
  const result = generateKeypair(argv[keyIndex + 1], argv[outputIndex + 1]);
  process.stdout.write(`Chave privada criada (nao compartilhe): ${result.outputPath}\n`);
  process.stdout.write(`UPDATE_PUBLIC_KEYS_JSON=${JSON.stringify({ [result.keyId]: result.publicKey })}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { generateKeypair, main };
