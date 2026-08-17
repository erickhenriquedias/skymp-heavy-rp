export type UpdateKind = 'client' | 'mods' | 'parity';

export type ReleaseState = {
  sequence: number;
  keyId: string;
  digest: string;
  issuedAt: string;
  expiresAt: string;
};

export type SignedUpdateEnvelope = {
  signatureVersion: 1;
  keyId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  payload: Record<string, unknown> & { kind: UpdateKind };
  signature: string;
};

export class SignedManifestError extends Error {
  code: string;
}

export function canonicalJson(value: unknown): string;
export function enforceReleaseMonotonicity(candidate: ReleaseState, highest?: ReleaseState | null): { ok: true };
export function manifestDigest(envelope: SignedUpdateEnvelope): string;
export function parsePinnedPublicKeys(value: string): Readonly<Record<string, string>>;
export function signUpdateManifest(input: {
  keyId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  payload: SignedUpdateEnvelope['payload'];
  privateKey: string;
}): SignedUpdateEnvelope;
export function signingBytes(envelope: SignedUpdateEnvelope): Buffer;
export function verifyUpdateManifest(envelope: unknown, options: {
  publicKeys: Record<string, string>;
  expectedKind?: UpdateKind;
  now?: Date | number;
  clockSkewMs?: number;
}): { payload: SignedUpdateEnvelope['payload']; release: ReleaseState };

declare const api: {
  SignedManifestError: typeof SignedManifestError;
  canonicalJson: typeof canonicalJson;
  enforceReleaseMonotonicity: typeof enforceReleaseMonotonicity;
  manifestDigest: typeof manifestDigest;
  parsePinnedPublicKeys: typeof parsePinnedPublicKeys;
  signUpdateManifest: typeof signUpdateManifest;
  signingBytes: typeof signingBytes;
  verifyUpdateManifest: typeof verifyUpdateManifest;
};
export default api;
