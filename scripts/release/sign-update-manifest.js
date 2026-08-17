'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { signUpdateManifest } = require('../../skymp/packages/signed-update-manifest.js');

function usage() {
  return 'Uso: node scripts/release/sign-update-manifest.js --input payload.json --output manifest.json --kind client|mods|parity --sequence N --key-id ID [--expires-hours 168 | --expires-at ISO] [--issued-at ISO]';
}

function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['input', 'output', 'kind', 'sequence', 'key-id', 'expires-hours', 'expires-at', 'issued-at']);
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith('--') || index + 1 >= argv.length) throw new Error(usage());
    const name = token.slice(2);
    if (!allowed.has(name) || Object.hasOwn(values, name)) throw new Error(`Argumento desconhecido ou repetido: ${token}`);
    values[name] = argv[index + 1];
  }
  for (const required of ['input', 'output', 'kind', 'sequence', 'key-id']) {
    if (!values[required]) throw new Error(`Falta --${required}. ${usage()}`);
  }
  if (!['client', 'mods', 'parity'].includes(values.kind)) throw new Error('--kind aceita somente client, mods ou parity.');
  const sequence = Number(values.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('--sequence precisa ser inteiro positivo.');
  if (values['expires-at'] && values['expires-hours']) throw new Error('Use somente --expires-at ou --expires-hours.');
  const expiresHours = values['expires-hours'] === undefined ? 168 : Number(values['expires-hours']);
  if (!values['expires-at'] && (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 24 * 31)) {
    throw new Error('--expires-hours precisa estar entre 0 e 744 horas.');
  }
  return { ...values, sequence, expiresHours };
}

function buildSignedManifest(options, privateKey, now = new Date()) {
  if (!privateKey) throw new Error('UPDATE_SIGNING_PRIVATE_KEY ausente. A chave privada deve existir somente no ambiente seguro de release.');
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  if (inputPath === outputPath) throw new Error('Entrada e saida precisam ser arquivos diferentes. Preserve o payload sem assinatura.');
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload precisa ser um objeto JSON.');
  if (payload.kind && payload.kind !== options.kind) throw new Error(`Payload declara kind=${payload.kind}, mas a linha de comando pediu ${options.kind}.`);
  if (!['stable', 'beta', 'development'].includes(payload.channel)) {
    throw new Error('Payload precisa declarar channel=stable, beta ou development antes de ser assinado.');
  }
  for (const reserved of ['signature', 'signatureVersion', 'keyId', 'sequence', 'issuedAt', 'expiresAt', 'payload']) {
    if (Object.hasOwn(payload, reserved)) throw new Error(`Payload contem campo reservado de envelope: ${reserved}.`);
  }
  const issuedAt = options['issued-at'] || now.toISOString();
  const expiresAt = options['expires-at'] || new Date(Date.parse(issuedAt) + options.expiresHours * 60 * 60_000).toISOString();
  return signUpdateManifest({
    keyId: options['key-id'],
    sequence: options.sequence,
    issuedAt,
    expiresAt,
    payload: { kind: options.kind, ...payload },
    privateKey,
  });
}

function writeManifestAtomic(output, manifest) {
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, outputPath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const manifest = buildSignedManifest(options, env.UPDATE_SIGNING_PRIVATE_KEY);
  writeManifestAtomic(options.output, manifest);
  process.stdout.write(`Manifesto ${options.kind} assinado: sequence=${options.sequence}, keyId=${options['key-id']}, output=${path.resolve(options.output)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildSignedManifest, main, parseArgs, usage, writeManifestAtomic };
