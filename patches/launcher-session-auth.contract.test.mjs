import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildSkyMpClientSettings } from '../apps/launcher/electron/auth-settings.mjs';

const require = createRequire(import.meta.url);
const ts = require('../apps/launcher/node_modules/typescript');
const here = path.dirname(fileURLToPath(import.meta.url));
const skyMpSourceDir = process.env.SKYMP_SOURCE_DIR
  ? path.resolve(process.env.SKYMP_SOURCE_DIR)
  : path.resolve(here, '../../skymp');
const authModelPath = path.resolve(
  skyMpSourceDir,
  'skymp5-client/src/features/authModel.ts'
);

function loadAuthModel() {
  const source = fs.readFileSync(authModelPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      strict: true,
    },
    fileName: authModelPath,
    reportDiagnostics: true,
  });

  const diagnostics = output.diagnostics || [];
  assert.equal(
    diagnostics.length,
    0,
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n')
  );

  const exports = {};
  vm.runInNewContext(output.outputText, { exports }, { filename: authModelPath });
  return exports;
}

test('launcher e cliente SkyMP concordam sobre gameData.session remoto', () => {
  const session = 'a'.repeat(64);
  const settings = buildSkyMpClientSettings(
    { gameData: { profileId: 1234, launcherTicket: 'legacy' } },
    { session, serverIp: '127.0.0.1', serverPort: 7777 }
  );
  const authModel = loadAuthModel();

  assert.deepEqual(
    JSON.parse(JSON.stringify(authModel.getAuthGameDataFromSettings(settings.gameData))),
    {
      remote: {
        session,
        masterApiId: 0,
        discordUsername: null,
        discordDiscriminator: null,
        discordAvatar: null,
      },
    }
  );
});

test('sessão remota tem precedência sobre profileId legado', () => {
  const session = 'b'.repeat(64);
  const authModel = loadAuthModel();

  const result = authModel.getAuthGameDataFromSettings({ session, profileId: 999 });
  assert.equal(result.remote.session, session);
  assert.equal(result.local, undefined);
});

test('cliente preserva profileId somente para configuração offline sem sessão', () => {
  const authModel = loadAuthModel();

  assert.deepEqual(
    JSON.parse(JSON.stringify(authModel.getAuthGameDataFromSettings({ profileId: 42 }))),
    { local: { profileId: 42 } }
  );
  assert.equal(authModel.getAuthGameDataFromSettings({ session: 'curta' }), null);
});
