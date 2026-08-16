import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSkyMpClientSettings,
  validateSkyMpSession,
} from './auth-settings.mjs';

const SESSION = 'a'.repeat(64);

test('buildSkyMpClientSettings escreve a sessão remota que o SkyMP envia ao servidor', () => {
  const result = buildSkyMpClientSettings(
    {
      gameData: {
        profileId: 12345678,
        launcherTicket: 'legado',
        token: 'legado',
        preserved: true,
      },
      unrelated: 'preserved',
    },
    { session: SESSION, serverIp: '127.0.0.1', serverPort: 7777 }
  );

  assert.deepEqual(result.gameData, { preserved: true, session: SESSION });
  assert.equal(result['server-ip'], '127.0.0.1');
  assert.equal(result['server-port'], 7777);
  assert.equal(result.master, '');
  assert.equal(result.unrelated, 'preserved');
});

test('buildSkyMpClientSettings não altera o objeto recebido', () => {
  const current = { gameData: { profileId: 42 } };
  buildSkyMpClientSettings(current, { session: SESSION, serverIp: 'localhost', serverPort: 7777 });

  assert.deepEqual(current, { gameData: { profileId: 42 } });
});

test('validateSkyMpSession rejeita sessão ausente, curta, enorme ou com whitespace', () => {
  for (const invalid of [undefined, '', 'a'.repeat(31), 'a'.repeat(513), `${'a'.repeat(32)}\n`]) {
    assert.throws(() => validateSkyMpSession(invalid));
  }
});

test('buildSkyMpClientSettings rejeita endpoint inválido antes de escrever settings', () => {
  assert.throws(() => buildSkyMpClientSettings({}, { session: SESSION, serverIp: '', serverPort: 7777 }));
  assert.throws(() => buildSkyMpClientSettings({}, { session: SESSION, serverIp: 'localhost', serverPort: 70000 }));
});

