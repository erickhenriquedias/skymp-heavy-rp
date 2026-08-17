const CHANNELS = Object.freeze(['stable', 'beta', 'development']);

export function parseUpdateChannel(value, label = 'canal') {
  if (typeof value !== 'string' || !CHANNELS.includes(value)) {
    throw new Error(`${label} invalido: use stable, beta ou development.`);
  }
  return value;
}

export function releaseStateKey(kind, channel) {
  if (!['client', 'mods', 'parity'].includes(kind)) throw new Error('Tipo de release invalido.');
  return `${kind}:${parseUpdateChannel(channel)}`;
}

export function assertPayloadChannel(payload, expectedChannel, kind) {
  const expected = parseUpdateChannel(expectedChannel);
  if (!payload || typeof payload !== 'object' || payload.channel !== expected) {
    throw new Error(`Manifesto ${kind} pertence ao canal ${String(payload?.channel || 'ausente')}; esperado ${expected}.`);
  }
  return payload;
}

export function githubFeedUrl(repository, kind, channel) {
  if (!repository) return '';
  const selected = parseUpdateChannel(channel);
  if (kind === 'client') {
    return selected === 'stable'
      ? `https://github.com/${repository}/releases/latest/download/client-update.json`
      : `https://github.com/${repository}/releases/download/client-${selected}/client-update.json`;
  }
  if (kind === 'mods') {
    const tag = selected === 'stable' ? 'mods' : `mods-${selected}`;
    return `https://github.com/${repository}/releases/download/${tag}/mods-dist.json`;
  }
  throw new Error('Tipo de feed invalido.');
}

export function releaseForChannel(release, channel) {
  return { ...release, channel: parseUpdateChannel(channel) };
}

export function installedReleaseForChannel(release, channel) {
  if (!release) return null;
  const installedChannel = release.channel || 'stable';
  return installedChannel === parseUpdateChannel(channel) ? release : null;
}

export function rememberedReleaseCandidates(releases, kind, channel) {
  const selected = parseUpdateChannel(channel);
  const stateKey = releaseStateKey(kind, selected);
  return [releases[stateKey] || null, selected === 'stable' ? releases[kind] || null : null];
}
