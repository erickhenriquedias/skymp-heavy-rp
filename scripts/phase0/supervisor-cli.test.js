'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  checkTcpPort,
  checkTcpConnect,
  integerPort,
  loadServiceEnv,
  parseArgs,
  parseEnvFile,
  probeService,
} = require('./supervisor-cli');

describe('configuracao do supervisor', () => {
  test('argumentos possuem defaults seguros e limites explícitos', () => {
    const parsed = parseArgs(['--environment=staging', '--startup-timeout-ms=1234', '--no-skymp']);
    assert.equal(parsed.environment, 'staging');
    assert.equal(parsed.startupTimeoutMs, 1234);
    assert.equal(parsed.noSkyMp, true);
    assert.equal(parsed.checkOnly, false);
  });

  test('parser de env ignora comentarios e preserva valor depois do primeiro igual', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skyrp-supervisor-env-'));
    const file = path.join(root, '.env');
    try {
      await fs.writeFile(file, '# comentario\nPORT=3002\nTOKEN="abc=123"\nEMPTY=\n');
      assert.deepEqual(parseEnvFile(file), { PORT: '3002', TOKEN: 'abc=123', EMPTY: '' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('porta inválida falha antes de abrir processo', () => {
    assert.throws(() => integerPort('0', 3001, 'web'), /porta invalida/);
    assert.throws(() => integerPort('abc', 3001, 'web'), /porta invalida/);
    assert.equal(integerPort('7758', 3001, 'api'), 7758);
  });

  test('env ausente identifica o serviço sem revelar configuração', () => {
    assert.throws(
      () => loadServiceEnv(path.join(os.tmpdir(), 'skyrp-env-inexistente'), 'painel-web'),
      /painel-web: configuracao ausente/,
    );
  });
});

describe('portas e probes reais', () => {
  test('preflight detecta porta TCP ocupada', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    const port = server.address().port;
    try {
      await assert.rejects(checkTcpPort(port), /indisponivel/);
      assert.equal(await checkTcpConnect(port), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    assert.equal(await checkTcpConnect(port, 50), false);
  });

  test('separa liveness 200 de readiness 503', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200).end('{"ok":true}');
      } else {
        response.writeHead(503).end('{"ready":false}');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const result = await probeService({
        port,
        healthUrl: value => `http://127.0.0.1:${value}/health`,
        readyUrl: value => `http://127.0.0.1:${value}/ready`,
      }, {}, 10_000);
      assert.equal(result.alive, true);
      assert.equal(result.ready, false);
      assert.match(result.detail, /503/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
