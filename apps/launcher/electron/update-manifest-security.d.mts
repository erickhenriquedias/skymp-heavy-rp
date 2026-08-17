import type { ReleaseState, SignedUpdateEnvelope, UpdateKind } from '../../../skymp/packages/signed-update-manifest.js';

export class UpdateSecurityStateError extends Error {
  code: string;
}

export function validateReleaseState(value: unknown): ReleaseState;
export function readInstalledRelease(gamePath: string | undefined, filename: string): ReleaseState | null;
export function readRememberedReleases(statePath: string): Record<string, ReleaseState>;
export function chooseHighestRelease(first?: ReleaseState | null, second?: ReleaseState | null): ReleaseState | null;
export function verifySignedUpdateEnvelope(envelope: unknown, options: {
  kind: UpdateKind;
  publicKeys: string | Record<string, string>;
  installedRelease?: ReleaseState | null;
  rememberedRelease?: ReleaseState | null;
  now?: Date | number;
  clockSkewMs?: number;
}): { payload: SignedUpdateEnvelope['payload']; release: ReleaseState };
export function rememberAcceptedRelease(statePath: string, kind: string, release: unknown): ReleaseState;
export function serializeReleaseState(release: unknown): string;
