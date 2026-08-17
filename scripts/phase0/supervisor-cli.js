'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { ServiceSupervisor } = require('./service-supervisor');

function parseArgs(argv) {
  const value = key => argv.find(arg => arg.startsWith(`${key}=`))?.slice(key.length + 1);
  return {
    root: path.resolve(value('--root') || path.join(__dirname, '..', '..')),
    environment: value('--environment') || 'local',
    startupTimeoutMs: Number(value('--startup-timeout-ms')) || 60_000,
    checkOnly: argv.includes('--check'),
    noSkyMp: argv.includes('--no-skymp'),
  };
}

function parseEnvFile(filePath) {
  const values = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadServiceEnv(filePath, serviceName) {
  if (!fs.existsSync(filePath)) throw new Error(`${serviceName}: configuracao ausente (${filePath})`);
  return parseEnvFile(filePath);
}

function integerPort(value, fallback, label) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}: porta invalida (${value})`);
  }
  return port;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildServices(options) {
  const service = (name, relativeCwd, entry, envFile, port, extra = {}) => ({
    name,
    cwd: path.join(options.root, relativeCwd),
    entry,
    envFile: path.join(options.root, envFile),
    port,
    protocol: 'tcp',
    ...extra,
  });
  const webEnv = loadServiceEnv(path.join(options.root, 'apps', 'web', '.env'), 'painel-web');
  const botEnv = loadServiceEnv(path.join(options.root, 'apps', 'bot-discord', '.env'), 'discord-bot');
  const apiEnv = loadServiceEnv(path.join(options.root, 'apps', 'game-api', '.env'), 'game-api');
  const services = [
    service('painel-web', 'apps/web', 'server.js', 'apps/web/.env', integerPort(webEnv.PANEL_PORT, 3001, 'painel-web'), {
      requiredEnv: ['SESSION_SECRET', 'INTERNAL_API_SECRET', 'MASTER_KEY', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
      healthUrl: port => `http://127.0.0.1:${port}/health`,
      readyUrl: port => `http://127.0.0.1:${port}/ready`,
    }),
    service('discord-bot', 'apps/bot-discord', 'index.js', 'apps/bot-discord/.env', integerPort(botEnv.PORT, 3002, 'discord-bot'), {
      requiredEnv: ['DISCORD_BOT_TOKEN', 'GUILD_ID', 'WHITELIST_ROLE_ID', 'INTERNAL_API_SECRET'],
      healthUrl: port => `http://127.0.0.1:${port}/health`,
      readyUrl: port => `http://127.0.0.1:${port}/ready`,
    }),
    service('game-api', 'apps/game-api', 'server.js', 'apps/game-api/.env', integerPort(apiEnv.GAME_API_PORT, 7758, 'game-api'), {
      requiredEnv: ['INTERNAL_API_SECRET', 'DB_HOST', 'DB_USER', 'DB_NAME'],
      healthUrl: port => `http://127.0.0.1:${port}/health`,
      readyUrl: port => `http://127.0.0.1:${port}/ready`,
    }),
  ];

  if (!options.noSkyMp) {
    const serverCwd = path.join(options.root, 'skymp', 'server');
    const settingsPath = path.join(serverCwd, 'server-settings.json');
    const settings = readJson(settingsPath);
    services.push({
      name: 'skymp-server',
      cwd: serverCwd,
      entry: path.join('dist_back', 'skymp5-server.js'),
      envFile: path.join(options.root, 'skymp', 'gamemode', '.env'),
      port: integerPort(settings.port, 7777, 'skymp-server'),
      protocol: 'udp',
      processReadyAfterMs: 5_000,
      tcpReadyPort: integerPort(Number(settings.port || 7777) + 1, 7778, 'skymp-ui'),
      additionalPorts: [{ protocol: 'tcp', port: integerPort(Number(settings.port || 7777) + 1, 7778, 'skymp-ui') }],
    });
  }
  return services;
}

function checkTcpPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => reject(new Error(`porta TCP ${port} indisponivel: ${error.code || error.message}`)));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => server.close(resolve));
  });
}

function checkUdpPort(port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    socket.once('error', error => {
      socket.close();
      reject(new Error(`porta UDP ${port} indisponivel: ${error.code || error.message}`));
    });
    socket.bind(port, '0.0.0.0', () => socket.close(resolve));
  });
}

async function preflightService(service) {
  const entryPath = path.resolve(service.cwd, service.entry);
  if (!fs.existsSync(entryPath)) throw new Error(`${service.name}: entrypoint ausente (${entryPath})`);
  if (!fs.existsSync(service.envFile)) throw new Error(`${service.name}: configuracao ausente (${service.envFile})`);
  const env = parseEnvFile(service.envFile);
  const missing = (service.requiredEnv || []).filter(key => !env[key] || /^(changeme|replace|example|<.+>)$/i.test(env[key]));
  if (missing.length > 0) throw new Error(`${service.name}: variaveis obrigatorias ausentes ou placeholder (${missing.join(', ')})`);
  if (service.name !== 'skymp-server' && !fs.existsSync(path.join(service.cwd, 'node_modules'))) {
    throw new Error(`${service.name}: node_modules ausente; execute npm ci em ${service.cwd}`);
  }
  await (service.protocol === 'udp' ? checkUdpPort(service.port) : checkTcpPort(service.port));
  for (const additional of service.additionalPorts || []) {
    await (additional.protocol === 'udp' ? checkUdpPort(additional.port) : checkTcpPort(additional.port));
  }
}

function checkTcpConnect(port, timeoutMs = 2_000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = connected => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function requestStatus(url, timeoutMs = 2_000) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode });
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', error => resolve({ ok: false, error: error.message }));
  });
}

async function probeService(service, _child, uptimeMs) {
  if (!service.healthUrl) {
    const stable = uptimeMs >= service.processReadyAfterMs;
    const portReady = stable && service.tcpReadyPort ? await checkTcpConnect(service.tcpReadyPort) : stable;
    return { alive: true, ready: portReady, detail: portReady ? null : 'aguardando porta de UI e janela minima de estabilidade' };
  }
  const health = await requestStatus(service.healthUrl(service.port));
  if (!health.ok) return { alive: false, ready: false, detail: health.error || `health HTTP ${health.status}` };
  const readiness = await requestStatus(service.readyUrl(service.port));
  return {
    alive: true,
    ready: readiness.ok,
    detail: readiness.ok ? null : readiness.error || `ready HTTP ${readiness.status}`,
  };
}

function prefixLines(stream, prefix, destination) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) destination.write(`[${prefix}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) destination.write(`[${prefix}] ${pending}\n`);
  });
}

function spawnService(service) {
  const env = { ...process.env, ...parseEnvFile(service.envFile) };
  const child = spawn(process.execPath, [service.entry], {
    cwd: service.cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  prefixLines(child.stdout, service.name, process.stdout);
  prefixLines(child.stderr, service.name, process.stderr);
  return child;
}

function log(level, service, message) {
  const line = `[supervisor] [${level.toUpperCase()}] [${service}] ${message}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let services;
  try {
    services = buildServices(options);
    const keys = new Set();
    for (const service of services) {
      for (const endpoint of [{ protocol: service.protocol, port: service.port }, ...(service.additionalPorts || [])]) {
        const key = `${endpoint.protocol}:${endpoint.port}`;
        if (keys.has(key)) throw new Error(`colisao de porta entre servicos: ${key}`);
        keys.add(key);
      }
    }
  } catch (error) {
    log('error', 'preflight', error.message);
    return 1;
  }

  if (options.checkOnly) {
    try {
      for (const service of services) await preflightService(service);
      log('info', 'preflight', `${services.length} servicos aprovados; nenhuma porta foi aberta`);
      return 0;
    } catch (error) {
      log('error', 'preflight', error.message);
      return 1;
    }
  }

  const supervisor = new ServiceSupervisor(services, {
    spawn: spawnService,
    preflight: preflightService,
    probe: probeService,
    log,
  });
  const stop = signal => {
    log('info', 'supervisor', `recebido ${signal}; iniciando shutdown`);
    // No Windows, Ctrl+C e entregue ao grupo inteiro do console. Reenviar
    // SIGTERM com child.kill usaria TerminateProcess e cortaria o cleanup que
    // os filhos acabaram de iniciar; apenas esperamos e forçamos no timeout.
    const initialSignal = process.platform === 'win32' && signal === 'SIGINT' ? null : signal;
    supervisor.stop(0, { initialSignal }).catch(error => log('error', 'supervisor', error.message));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  try {
    await supervisor.start();
    const ready = await supervisor.waitForReady(options.startupTimeoutMs);
    if (!ready) {
      log('error', 'readiness', `timeout apos ${options.startupTimeoutMs}ms: ${JSON.stringify(supervisor.snapshot())}`);
      await supervisor.stop(1);
    } else {
      log('info', 'readiness', 'todos os servicos estao prontos');
    }
    return await supervisor.wait();
  } catch (error) {
    log('error', 'supervisor', error.message);
    await supervisor.stop(1);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = {
  buildServices,
  checkTcpConnect,
  checkTcpPort,
  checkUdpPort,
  integerPort,
  loadServiceEnv,
  main,
  parseArgs,
  parseEnvFile,
  preflightService,
  probeService,
  requestStatus,
};
