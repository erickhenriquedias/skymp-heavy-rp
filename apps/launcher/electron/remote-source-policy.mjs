export const TRUSTED_UPDATE_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export class RemoteSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteSourceError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new RemoteSourceError(code, message);
}

export function assertTrustedUpdateUrl(rawUrl, allowedHosts = TRUSTED_UPDATE_HOSTS) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    reject('UPDATE_URL_INVALID', 'A atualização informou uma URL inválida.');
  }

  if (parsed.protocol !== 'https:') {
    reject('UPDATE_URL_INSECURE', `Atualização bloqueada: protocolo não seguro (${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    reject('UPDATE_URL_CREDENTIALS', 'Atualização bloqueada: credenciais embutidas na URL.');
  }
  if (parsed.port && parsed.port !== '443') {
    reject('UPDATE_URL_PORT', `Atualização bloqueada: porta remota não autorizada (${parsed.port}).`);
  }

  const trusted = new Set(Array.from(allowedHosts, host => String(host).toLowerCase()));
  const hostname = parsed.hostname.toLowerCase();
  if (!trusted.has(hostname)) {
    reject('UPDATE_HOST_NOT_ALLOWED', `Atualização bloqueada: host não autorizado (${hostname}).`);
  }

  return parsed;
}

