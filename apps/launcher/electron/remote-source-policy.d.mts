export const TRUSTED_UPDATE_HOSTS: readonly string[];

export class RemoteSourceError extends Error {
  code: string;
}

export function assertTrustedUpdateUrl(
  rawUrl: string,
  allowedHosts?: Iterable<string>,
): URL;

