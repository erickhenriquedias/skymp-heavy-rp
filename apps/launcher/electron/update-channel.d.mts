export type UpdateChannel = 'stable' | 'beta' | 'development';
export function parseUpdateChannel(value: string, label?: string): UpdateChannel;
export function releaseStateKey(kind: 'client' | 'mods' | 'parity', channel: UpdateChannel): string;
export function assertPayloadChannel<T>(payload: T, expectedChannel: UpdateChannel, kind: string): T;
export function githubFeedUrl(repository: string, kind: 'client' | 'mods', channel: UpdateChannel): string;
export function releaseForChannel<T extends object>(release: T, channel: UpdateChannel): T & { channel: UpdateChannel };
export function installedReleaseForChannel<T>(release: T | null, channel: UpdateChannel): T | null;
export function rememberedReleaseCandidates<T>(
  releases: Record<string, T>,
  kind: 'client' | 'mods' | 'parity',
  channel: UpdateChannel,
): [T | null, T | null];
