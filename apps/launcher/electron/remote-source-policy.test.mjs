import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTrustedUpdateUrl,
  RemoteSourceError,
  TRUSTED_UPDATE_HOSTS,
} from './remote-source-policy.mjs';

function rejectsWithCode(url, code) {
  assert.throws(
    () => assertTrustedUpdateUrl(url),
    error => error instanceof RemoteSourceError && error.code === code,
  );
}

describe('origens remotas do atualizador', () => {
  test('aceita GitHub Releases e os hosts oficiais de assets', () => {
    for (const host of TRUSTED_UPDATE_HOSTS) {
      const parsed = assertTrustedUpdateUrl(`https://${host}/owner/repo/file.zip`);
      assert.equal(parsed.hostname, host);
    }
  });

  test('recusa manifesto ou download servido por HTTP', () => {
    rejectsWithCode('http://github.com/owner/repo/file.zip', 'UPDATE_URL_INSECURE');
  });

  test('recusa host externo informado pelo manifesto', () => {
    rejectsWithCode('https://downloads.example.com/modpack.zip', 'UPDATE_HOST_NOT_ALLOWED');
  });

  test('recusa host parecido que apenas termina com domínio confiável', () => {
    rejectsWithCode('https://github.com.attacker.example/modpack.zip', 'UPDATE_HOST_NOT_ALLOWED');
    rejectsWithCode('https://release-assets.githubusercontent.com.attacker.example/file', 'UPDATE_HOST_NOT_ALLOWED');
  });

  test('recusa credenciais embutidas e porta não padrão', () => {
    rejectsWithCode('https://user:pass@github.com/file', 'UPDATE_URL_CREDENTIALS');
    rejectsWithCode('https://github.com:8443/file', 'UPDATE_URL_PORT');
  });

  test('recusa URL malformada', () => {
    rejectsWithCode('não é uma url', 'UPDATE_URL_INVALID');
  });

  test('a política também recusa o destino de redirecionamento hostil', () => {
    const redirect = new URL('https://evil.example/file.zip', 'https://github.com/start').toString();
    rejectsWithCode(redirect, 'UPDATE_HOST_NOT_ALLOWED');
  });
});

