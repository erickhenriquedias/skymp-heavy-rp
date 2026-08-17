'use strict';

const crypto = require('node:crypto');

const SIGNATURE_VERSION = 1;
const MAX_VALIDITY_MS = 31 * 24 * 60 * 60_000;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KINDS = new Set(['client', 'mods', 'parity']);
const ENVELOPE_FIELDS = new Set(['signatureVersion', 'keyId', 'sequence', 'issuedAt', 'expiresAt', 'payload', 'signature']);

class SignedManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SignedManifestError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SignedManifestError(code, message);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('MANIFEST_CANONICAL_VALUE', 'O manifesto aceita somente numeros inteiros seguros.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('MANIFEST_CANONICAL_VALUE', 'O manifesto contem objeto nao serializavel.');
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail('MANIFEST_CANONICAL_VALUE', 'O manifesto contem valor nao serializavel.');
}

function unsignedEnvelope(envelope) {
  return {
    signatureVersion: envelope.signatureVersion,
    keyId: envelope.keyId,
    sequence: envelope.sequence,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    payload: envelope.payload,
  };
}

function signingBytes(envelope) {
  return Buffer.from(canonicalJson(unsignedEnvelope(envelope)), 'utf8');
}

function parseTimestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(code, 'Timestamp do manifesto possui formato invalido.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(code, 'Timestamp do manifesto nao representa uma data valida.');
  }
  return timestamp;
}

function validateEnvelopeShape(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    fail('MANIFEST_INVALID_ENVELOPE', 'Envelope assinado ausente ou invalido.');
  }
  if (envelope.signatureVersion !== SIGNATURE_VERSION) {
    fail('MANIFEST_SIGNATURE_VERSION', 'Versao de assinatura desconhecida. Atualize o launcher.');
  }
  for (const field of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.has(field)) fail('MANIFEST_UNKNOWN_FIELD', `Campo desconhecido no envelope assinado: ${field}.`);
  }
  if (typeof envelope.keyId !== 'string' || !KEY_ID_PATTERN.test(envelope.keyId)) {
    fail('MANIFEST_KEY_ID', 'Identificador da chave de assinatura invalido.');
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    fail('MANIFEST_SEQUENCE', 'Sequencia de release invalida.');
  }
  const issuedAt = parseTimestamp(envelope.issuedAt, 'MANIFEST_ISSUED_AT');
  const expiresAt = parseTimestamp(envelope.expiresAt, 'MANIFEST_EXPIRES_AT');
  if (expiresAt <= issuedAt) fail('MANIFEST_VALIDITY_WINDOW', 'Validade do manifesto deve terminar depois da emissao.');
  if (expiresAt - issuedAt > MAX_VALIDITY_MS) fail('MANIFEST_VALIDITY_WINDOW', 'Validade do manifesto excede o limite de 31 dias.');
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    fail('MANIFEST_PAYLOAD', 'Payload de update ausente ou invalido.');
  }
  if (!KINDS.has(envelope.payload.kind)) fail('MANIFEST_KIND', 'Tipo de manifesto desconhecido.');
  if (options.expectedKind && envelope.payload.kind !== options.expectedKind) {
    fail('MANIFEST_KIND', `Manifesto ${envelope.payload.kind} recebido no canal ${options.expectedKind}.`);
  }
  if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)) {
    fail('MANIFEST_SIGNATURE_FORMAT', 'Assinatura do manifesto ausente ou malformada.');
  }
  return { issuedAt, expiresAt };
}

function publicKeyFromBase64(value) {
  if (typeof value !== 'string' || value.length < 32) fail('MANIFEST_PUBLIC_KEY', 'Chave publica pinada invalida.');
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') fail('MANIFEST_PUBLIC_KEY', 'Chave publica pinada nao e Ed25519.');
    return key;
  } catch {
    fail('MANIFEST_PUBLIC_KEY', 'Chave publica pinada nao e Ed25519/SPKI valida.');
  }
}

function privateKeyFromBase64(value) {
  if (typeof value !== 'string' || value.length < 32) fail('MANIFEST_PRIVATE_KEY', 'Chave privada de release invalida.');
  try {
    const key = crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') fail('MANIFEST_PRIVATE_KEY', 'Chave privada de release nao e Ed25519.');
    return key;
  } catch {
    fail('MANIFEST_PRIVATE_KEY', 'Chave privada nao e Ed25519/PKCS8 valida.');
  }
}

function manifestDigest(envelope) {
  return crypto.createHash('sha256').update(signingBytes(envelope)).digest('hex');
}

function signUpdateManifest(input) {
  const envelope = {
    signatureVersion: SIGNATURE_VERSION,
    keyId: input.keyId,
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    payload: input.payload,
    signature: 'placeholder',
  };
  validateEnvelopeShape(envelope, { expectedKind: input.payload?.kind });
  const signature = crypto.sign(null, signingBytes(envelope), privateKeyFromBase64(input.privateKey));
  return { ...unsignedEnvelope(envelope), signature: signature.toString('base64') };
}

function verifyUpdateManifest(envelope, options = {}) {
  const times = validateEnvelopeShape(envelope, options);
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) fail('MANIFEST_CLOCK', 'Relogio usado para validar o manifesto e invalido.');
  const clockSkewMs = Number.isFinite(options.clockSkewMs) ? Math.max(0, options.clockSkewMs) : 5 * 60_000;
  if (times.issuedAt > now + clockSkewMs) fail('MANIFEST_NOT_YET_VALID', 'Manifesto foi emitido no futuro.');
  if (times.expiresAt < now - clockSkewMs) fail('MANIFEST_EXPIRED', 'Manifesto de update expirou.');

  const pinnedKeys = options.publicKeys;
  if (!pinnedKeys || typeof pinnedKeys !== 'object' || Array.isArray(pinnedKeys)) {
    fail('MANIFEST_KEYS_MISSING', 'Launcher nao possui chaves publicas de update configuradas.');
  }
  const encodedKey = Object.prototype.hasOwnProperty.call(pinnedKeys, envelope.keyId)
    ? pinnedKeys[envelope.keyId]
    : null;
  if (!encodedKey) fail('MANIFEST_KEY_UNKNOWN', 'Manifesto usa chave desconhecida ou revogada.');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || !crypto.verify(null, signingBytes(envelope), publicKeyFromBase64(encodedKey), signature)) {
    fail('MANIFEST_SIGNATURE_INVALID', 'Assinatura do manifesto nao confere.');
  }
  return {
    payload: envelope.payload,
    release: {
      sequence: envelope.sequence,
      keyId: envelope.keyId,
      digest: manifestDigest(envelope),
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    },
  };
}

function enforceReleaseMonotonicity(candidate, highest) {
  if (!highest) return { ok: true };
  if (!Number.isSafeInteger(highest.sequence) || typeof highest.digest !== 'string') {
    fail('MANIFEST_LOCAL_STATE', 'Estado local de seguranca de update esta corrompido.');
  }
  if (candidate.sequence < highest.sequence) {
    fail('MANIFEST_DOWNGRADE', `Release ${candidate.sequence} e anterior ao maior numero aceito (${highest.sequence}).`);
  }
  if (candidate.sequence === highest.sequence && candidate.digest !== highest.digest) {
    fail('MANIFEST_SEQUENCE_REUSE', 'A mesma sequencia foi reutilizada com conteudo diferente.');
  }
  return { ok: true };
}

function parsePinnedPublicKeys(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('MANIFEST_KEYS_MISSING', 'Configuracao de chaves publicas nao e JSON valido.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    fail('MANIFEST_KEYS_MISSING', 'Nenhuma chave publica de update foi pinada.');
  }
  for (const [keyId, key] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(keyId)) fail('MANIFEST_KEY_ID', 'Configuracao contem keyId invalido.');
    publicKeyFromBase64(key);
  }
  return Object.freeze({ ...parsed });
}

module.exports = {
  KEY_ID_PATTERN,
  SIGNATURE_VERSION,
  SignedManifestError,
  canonicalJson,
  enforceReleaseMonotonicity,
  manifestDigest,
  parsePinnedPublicKeys,
  signUpdateManifest,
  signingBytes,
  verifyUpdateManifest,
};
