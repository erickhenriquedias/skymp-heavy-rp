/**
 * apps/game-api — API do servidor de jogo (porta 7758)
 *
 * O launcher já chamava estes endpoints desde sempre; o serviço é que não
 * existia. Enquanto isso, `verify-mods` sempre falhava com "servidor offline" e
 * a fila nunca respondia — ou seja, a verificação de paridade de modpack, que é
 * a base da regra de Autoridade do Servidor, nunca chegou a rodar.
 *
 * Endpoints públicos (chamados pelo launcher do jogador):
 *   GET  /mods.json             → manifesto de paridade { mods, loadOrder }
 *   POST /api/queue/join        → { ticket } → entra na fila
 *   POST /api/queue/status      → { ticket } → posição ou ticket de sessão
 *   GET  /health                → diagnóstico
 *
 * Endpoints internos (X-Internal-Secret, chamados pelo gamemode):
 *   POST /internal/session/resolve   → valida ticket de sessão e marca conectado
 *   POST /internal/session/connected → master confirma a sessão exata
 *   POST /internal/session/claim     → gamemode obtém lease opaco da conexão
 *   POST /internal/session/release   → libera somente o lease exato
 *
 * Por que a fila não aceita `discordId` direto: `discordId` é público. O
 * launcher apresenta um ticket emitido pelo painel (que é quem tem o client
 * secret do Discord e portanto é o único capaz de provar que aquele Discord
 * autenticou de fato). Ver migration-v6-launch-tickets.sql.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const { createQueue, DEFAULT_RESERVATION_TTL_MS } = require('./queue');
const { recoverQueueState } = require('./queueRecovery');
const { createSessionLeaseService } = require('./sessionLeaseService');
const { createReadinessProbe } = require('./readiness');
const { createManifestLoader } = require('./modsManifest');
const {
  cleanupExpiredCredentials,
  createCleanupScheduler
} = require('./credentialRetention');
const { createSlidingWindowRateLimiter } = require('../../skymp/packages/sliding-rate-limiter');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const PORT = parseInt(process.env.GAME_API_PORT || '7758', 10);
const HOST = process.env.GAME_API_BIND_HOST || '0.0.0.0';
const MANIFEST_PATH = process.env.MODS_MANIFEST_PATH || path.join(__dirname, 'mods.json');

function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeMaintenanceMessage(value) {
  const message = String(value || '').trim();
  if (!message) return 'Servidor em manutenção. Tente novamente em breve.';
  if (message.length > 160) throw new Error('MAINTENANCE_MESSAGE must have at most 160 characters');
  return message;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const INTERNAL_API_SECRET = requireEnv('INTERNAL_API_SECRET');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'skymp_rp',
  waitForConnections: true,
  connectionLimit: 5
});

const db = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const credentialCleanupOptions = Object.freeze({
  launchTicketRetentionMs: readPositiveInteger('LAUNCH_TICKET_RETENTION_SECONDS', 24 * 60 * 60) * 1000,
  gameSessionRetentionMs: readPositiveInteger('GAME_SESSION_RETENTION_SECONDS', 7 * 24 * 60 * 60) * 1000,
  batchSize: readPositiveInteger('CREDENTIAL_CLEANUP_BATCH_SIZE', 500),
  maxBatches: readPositiveInteger('CREDENTIAL_CLEANUP_MAX_BATCHES', 10)
});

const credentialCleanupScheduler = createCleanupScheduler({
  intervalMs: readPositiveInteger('CREDENTIAL_CLEANUP_INTERVAL_SECONDS', 15 * 60) * 1000,
  cleanup: async () => {
    const summary = await cleanupExpiredCredentials({
      execute: async (sql, params) => {
        const [result] = await pool.execute(sql, params);
        return result;
      },
      ...credentialCleanupOptions
    });
    const deleted = summary.launchTickets.deleted + summary.gameSessions.deleted;
    if (deleted > 0) {
      console.log(`[game-api] Retencao removeu ${summary.launchTickets.deleted} launch_tickets e ${summary.gameSessions.deleted} game_sessions.`);
    }
    if (summary.launchTickets.saturated || summary.gameSessions.saturated) {
      console.warn('[game-api] Retencao atingiu o limite de lotes; o backlog continua na proxima rodada.');
    }
    return summary;
  }
});

function scheduleCredentialCleanup(options) {
  const pending = credentialCleanupScheduler.trigger(options);
  if (pending) {
    pending.catch((err) => {
      console.error('[game-api] Falha na retencao de credenciais:', err.message);
    });
  }
}

const manifestLoader = createManifestLoader(MANIFEST_PATH, {
  publicKeys: process.env.MODS_MANIFEST_PUBLIC_KEYS || ''
});
const queue = createQueue({ capacity: parseInt(process.env.QUEUE_CAPACITY || '40', 10) });
let maintenanceMode = readBooleanEnv('MAINTENANCE_MODE');
let maintenanceMessage = normalizeMaintenanceMessage(process.env.MAINTENANCE_MESSAGE);

const makeSessionTicket = () => crypto.randomBytes(32).toString('hex');

// Quanto tempo a sessão de jogo vale. Precisa cobrir uma sessão inteira, com
// folga pra reconectar depois de um crash — o servidor de jogo consulta o
// master a cada conexão.
const GAME_SESSION_TTL_SECONDS = parseInt(process.env.GAME_SESSION_TTL_SECONDS || String(12 * 60 * 60), 10);

/**
 * Grava a sessão que o servidor de jogo vai resolver contra o master API
 * (`apps/web`, `GET /api/servers/:masterKey/sessions/:session`).
 *
 * É este registro que faz o `profileId` deixar de ser uma declaração do
 * cliente: o SkyMP com `offlineMode: false` não lê o `profileId` do
 * `skymp_config.json`, ele pergunta ao master quem é o dono da sessão.
 *
 * Guardamos só o hash — se o banco vazar, as sessões em voo não viram
 * credencial. Mesmo critério de `launch_tickets`.
 */
async function persistGameSession(token, accountId, discordId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [accounts] = await connection.execute(
      'SELECT id FROM accounts WHERE id = ? FOR UPDATE',
      [accountId]
    );
    if (accounts.length !== 1) throw new Error('account_not_found');
    await connection.execute(
      `UPDATE game_sessions
          SET revoked_at = NOW(), disconnected_at = COALESCE(disconnected_at, NOW(6)),
              connection_lease_hash = NULL
        WHERE account_id = ? AND revoked_at IS NULL`,
      [accountId]
    );
    const [result] = await connection.execute(
      `INSERT INTO game_sessions (token_hash, account_id, discord_id, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [hashTicket(token), accountId, discordId, GAME_SESSION_TTL_SECONDS]
    );
    await connection.commit();
    return Number(result.insertId);
  } catch (err) {
    try { await connection.rollback(); } catch (_) { /* o erro original governa */ }
    throw err;
  } finally {
    connection.release();
  }
}

const admissionPersistenceLocks = new Map();

function withAdmissionPersistenceLock(accountId, operation) {
  const previous = admissionPersistenceLocks.get(accountId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  admissionPersistenceLocks.set(accountId, current);
  return current.finally(() => {
    if (admissionPersistenceLocks.get(accountId) === current) {
      admissionPersistenceLocks.delete(accountId);
    }
  });
}

/**
 * Persiste a sessão de quem acabou de ser admitido.
 *
 * A fila é síncrona e em memória (pra ser testável sem banco), então a
 * gravação acontece aqui, depois. Se falhar, a admissão é desfeita: entrar na
 * fila e receber um ticket que o servidor de jogo vai recusar seria pior que
 * um erro honesto — o jogador ficaria olhando o Skyrim não conectar sem
 * entender por quê.
 */
async function persistAdmission(result, identity) {
  if (result.status !== 'success' || !result.ticket) return result;
  return withAdmissionPersistenceLock(identity.accountId, async () => {
    try {
      const existing = queue.getAdmission(identity.accountId);
      if (!existing || existing.sessionTicket !== result.ticket) {
        throw new Error('admission_changed_before_persistence');
      }
      // Dois polls podem observar o mesmo ticket antes do primeiro INSERT
      // terminar. O lock por conta transforma o segundo em leitura idempotente.
      if (Number.isSafeInteger(existing.sessionId) && existing.sessionId > 0) return result;

      const sessionId = await persistGameSession(result.ticket, identity.accountId, identity.discordId);
      if (!queue.bindSession(identity.accountId, result.ticket, sessionId)) {
        await db(
          `UPDATE game_sessions
              SET revoked_at = NOW(), disconnected_at = NOW(6)
            WHERE id = ? AND revoked_at IS NULL`,
          [sessionId]
        );
        throw new Error('admission_changed_during_persistence');
      }
      return result;
    } catch (err) {
      console.error('[game-api] Falha ao gravar game_session:', err.message);
      const current = queue.getAdmission(identity.accountId);
      if (current?.sessionTicket === result.ticket) {
        if (!queue.restoreSuperseded(identity.accountId, result.ticket)) {
          queue.release(identity.accountId, makeSessionTicket);
        }
      }
      return { status: 'error', message: 'session_persist_failed' };
    }
  });
}

let sessionLeaseService = createSessionLeaseService({
  execute: db,
  queue,
  hashToken: hashTicket,
  makeToken: makeSessionTicket,
  makeSessionTicket
});

function setSessionLeaseServiceForTests(service) {
  if (!service || typeof service.confirmConnected !== 'function' ||
    typeof service.claim !== 'function' || typeof service.release !== 'function') {
    throw new TypeError('session lease service inválido');
  }
  sessionLeaseService = service;
}

// ── Rate limiting (janela deslizante em memória) ────────────────────────────
const rateLimiter = createSlidingWindowRateLimiter();
function isRateLimited(key, maxRequests, windowMs) {
  return rateLimiter.isLimited(key, maxRequests, windowMs);
}

function isValidInternalSecret(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = Buffer.from(INTERNAL_API_SECRET);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function requireInternal(req, res, next) {
  if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function rejectDuringMaintenance(_req, res, next) {
  if (!maintenanceMode) return next();
  return res.status(503).json({ status: 'maintenance', message: maintenanceMessage });
}

function hashTicket(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Valida e consome um ticket de lançamento emitido pelo painel.
 *
 * O UPDATE condicional é o que garante uso único sob concorrência: dois
 * pedidos simultâneos com o mesmo ticket disputam a mesma linha e só um deles
 * vê `affectedRows === 1`. Checar-e-depois-marcar em dois passos deixaria uma
 * janela pra ambos passarem.
 */
async function consumeLaunchTicket(token) {
  if (typeof token !== 'string' || token.length < 32) return null;

  const tokenHash = hashTicket(token);
  const [result] = await pool.execute(
    `UPDATE launch_tickets SET consumed_at = NOW()
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (result.affectedRows !== 1) return null;

  const rows = await db('SELECT account_id, discord_id FROM launch_tickets WHERE token_hash = ?', [tokenHash]);
  if (rows.length === 0) return null;
  return { accountId: rows[0].account_id, discordId: rows[0].discord_id };
}

/**
 * Confere que a conta continua elegível a entrar. O ticket prova *quem* é a
 * pessoa; isto prova que ela ainda *pode* jogar — uma conta pode ter sido
 * banida entre o login no launcher e a entrada na fila.
 */
async function isEligible(accountId) {
  const rows = await db(
    `SELECT a.status,
            (SELECT COUNT(*) FROM whitelist_applications w
              WHERE w.account_id = a.id
                AND w.status = 'approved'
                AND (
                  COALESCE(w.approval_source, 'staff') <> 'discord_role'
                  OR EXISTS (
                    SELECT 1 FROM discord_role_access dra
                     WHERE dra.account_id = a.id
                       AND dra.eligible = 1
                       AND dra.expires_at > NOW()
                  )
                )) AS approved_apps,
            (SELECT COUNT(*) FROM characters c
              WHERE c.account_id = a.id AND c.status = 'approved') AS approved_chars
     FROM accounts a WHERE a.id = ?`,
    [accountId]
  );
  if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
  if (rows[0].status !== 'active') return { ok: false, reason: 'account_not_active' };
  if (Number(rows[0].approved_apps) === 0) return { ok: false, reason: 'not_whitelisted' };
  if (Number(rows[0].approved_chars) === 0) return { ok: false, reason: 'no_approved_character' };
  return { ok: true };
}

// ── Paridade de modpack ─────────────────────────────────────────────────────

app.get('/mods.json', (req, res) => {
  const result = manifestLoader.load();
  if (!result.ok) {
    // 503 e não 200-com-lista-vazia: uma lista vazia passaria na verificação do
    // launcher e deixaria qualquer modpack entrar.
    console.error(`[game-api] Manifesto indisponivel: ${result.reason} (${MANIFEST_PATH})`);
    return res.status(503).json({ error: 'Manifesto de mods indisponivel no servidor.' });
  }
  res.json(result.envelope);
});

// ── Fila ────────────────────────────────────────────────────────────────────

app.post('/api/queue/join', rejectDuringMaintenance, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-join:${ip}`, 20, 60 * 1000)) {
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }
  scheduleCredentialCleanup();

  try {
    const identity = await consumeLaunchTicket((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const eligible = await isEligible(identity.accountId);
    if (!eligible.ok) return res.status(403).json({ status: 'error', message: eligible.reason });

    const result = await persistAdmission(
      queue.join(identity.accountId, identity.discordId, makeSessionTicket),
      identity
    );

    // O launcher precisa reconsultar a fila, e o ticket de lançamento acabou de
    // ser consumido — então devolvemos um ticket novo pro polling seguinte.
    if (result.status === 'queued') {
      result.pollTicket = await issuePollTicket(identity.accountId, identity.discordId, ip);
    }

    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/join', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

/**
 * POST e não GET, e o ticket vem no corpo e não na query string.
 *
 * O ticket é credencial: quem o tem entra na fila como aquela conta. Query
 * string entra em log de acesso de servidor e de proxy; corpo de POST não.
 * O `join` ao lado sempre leu do corpo — isto aqui lia da query, e eram dois
 * tratamentos diferentes pro mesmo segredo a catorze linhas de distância.
 *
 * O impacto era menor do que parece (o transporte já é HTTP puro, e os tickets
 * rotacionam e são de uso único), mas a inconsistência convidava a erro: o
 * próximo endpoint copiaria um dos dois, e metade das chances era a errada.
 *
 * `req.query` é deliberadamente ignorado. O teste de regressão em
 * `server.http.test.js` manda um ticket pela query e exige 401 — se alguém
 * reintroduzir a leitura por lá, aquele teste quebra.
 */
app.post('/api/queue/status', rejectDuringMaintenance, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-status:${ip}`, 120, 60 * 1000)) {
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }
  scheduleCredentialCleanup();

  try {
    const identity = await consumeLaunchTicket((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const result = await persistAdmission(
      queue.status(identity.accountId, makeSessionTicket),
      identity
    );
    if (result.status === 'queued') {
      result.pollTicket = await issuePollTicket(identity.accountId, identity.discordId, ip);
    }
    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/status', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

/**
 * Emite o ticket da próxima consulta. Mantém a propriedade de uso único (um
 * ticket capturado não serve pra nada, porque já foi gasto) sem obrigar o
 * jogador a refazer o login do Discord a cada 5 segundos de polling.
 */
async function issuePollTicket(accountId, discordId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  await db(
    `INSERT INTO launch_tickets (token_hash, account_id, discord_id, expires_at, issued_ip)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 300 SECOND), ?)`,
    [hashTicket(token), accountId, discordId, ip || null]
  );
  return token;
}

// ── Endpoints internos (gamemode) ───────────────────────────────────────────

app.post('/internal/session/resolve', requireInternal, (req, res) => {
  const entry = queue.resolveSessionTicket((req.body || {}).ticket);
  if (!entry) return res.status(404).json({ ok: false, error: 'unknown_session' });
  queue.markConnected(entry.accountId);
  res.json({ ok: true, accountId: entry.accountId, discordId: entry.discordId });
});

app.post('/internal/session/connected', requireInternal, async (req, res) => {
  const accountId = Number((req.body || {}).accountId);
  const sessionId = Number((req.body || {}).sessionId);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_account_id' });
  }
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  }
  try {
    const result = await sessionLeaseService.confirmConnected(accountId, sessionId);
    if (!result.ok) return res.status(409).json({ ok: false, error: result.reason });
    return res.json({ ok: true, marked: true });
  } catch (err) {
    console.error('[game-api] /internal/session/connected', err.message);
    return res.status(503).json({ ok: false, error: 'session_store_unavailable' });
  }
});

app.post('/internal/session/claim', requireInternal, async (req, res) => {
  const accountId = Number((req.body || {}).accountId);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_account_id' });
  }
  try {
    const result = await sessionLeaseService.claim(accountId);
    if (!result.ok) return res.status(409).json({ ok: false, error: result.reason });
    return res.json({ ok: true, leaseToken: result.leaseToken });
  } catch (err) {
    console.error('[game-api] /internal/session/claim', err.message);
    return res.status(503).json({ ok: false, error: 'session_store_unavailable' });
  }
});

app.post('/internal/session/release', requireInternal, async (req, res) => {
  try {
    const result = await sessionLeaseService.release((req.body || {}).leaseToken);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    console.error('[game-api] /internal/session/release', err.message);
    return res.status(503).json({ ok: false, released: false, error: 'session_store_unavailable' });
  }
});

// ── Diagnóstico operacional ─────────────────────────────────────────────────

// Liveness responde somente se o processo Express está vivo. Não consulta
// disco/banco e não expõe capacidade, ocupação ou quantidade de jogadores.
app.get('/health', (_req, res) => res.json({ ok: true }));

const defaultReadinessProbe = createReadinessProbe({
  execute: db,
  loadManifest: () => manifestLoader.load(),
  isMaintenance: () => maintenanceMode
});

let readinessProbe = defaultReadinessProbe;
const STATUS_READINESS_CACHE_MS = 2000;
let statusReadinessCache = null;
let statusReadinessPending = null;

function cachedStatusReadiness() {
  const now = Date.now();
  if (statusReadinessCache && now - statusReadinessCache.checkedAt < STATUS_READINESS_CACHE_MS) {
    return Promise.resolve(statusReadinessCache.result);
  }
  if (statusReadinessPending) return statusReadinessPending;
  statusReadinessPending = Promise.resolve()
    .then(() => readinessProbe())
    .then(result => {
      statusReadinessCache = { checkedAt: Date.now(), result };
      return result;
    })
    .finally(() => { statusReadinessPending = null; });
  return statusReadinessPending;
}

app.get('/ready', async (_req, res) => {
  try {
    const result = await readinessProbe();
    const ready = result?.ready === true;
    return res.status(ready ? 200 : 503).json({
      ready,
      checks: result?.checks || {
        database: 'unavailable', manifest: 'unavailable', maintenance: 'unknown'
      }
    });
  } catch (_) {
    return res.status(503).json({
      ready: false,
      checks: { database: 'unavailable', manifest: 'unavailable', maintenance: 'unknown' }
    });
  }
});

// Estado público para apresentação. Diferente de /health, estas contagens são
// deliberadamente públicas e não carregam contas, reservas ou identificadores.
app.get('/status', async (_req, res) => {
  if (maintenanceMode) {
    const snapshot = queue.snapshot();
    return res.json({
      state: 'maintenance',
      players: snapshot.connected,
      capacity: snapshot.capacity,
      queue: snapshot.waiting,
      message: maintenanceMessage
    });
  }

  let operational;
  try { operational = await cachedStatusReadiness(); } catch (_) { operational = { ready: false }; }
  const snapshot = queue.snapshot();
  if (operational?.ready !== true) {
    return res.json({
      state: 'starting',
      players: snapshot.connected,
      capacity: snapshot.capacity,
      queue: snapshot.waiting,
      message: 'Servidor inicializando ou temporariamente indisponível.'
    });
  }
  return res.json({
    state: snapshot.occupied >= snapshot.capacity ? 'full' : 'online',
    players: snapshot.connected,
    capacity: snapshot.capacity,
    queue: snapshot.waiting,
    message: null
  });
});

function setReadinessProbeForTests(probe) {
  statusReadinessCache = null;
  statusReadinessPending = null;
  if (probe === null) {
    readinessProbe = defaultReadinessProbe;
    return;
  }
  if (typeof probe !== 'function') throw new TypeError('readiness probe inválido');
  readinessProbe = probe;
}

function setMaintenanceForTests(enabled, message) {
  maintenanceMode = enabled === true;
  maintenanceMessage = normalizeMaintenanceMessage(message);
  statusReadinessCache = null;
}

async function recoverQueueOccupancy() {
  return recoverQueueState({
    execute: db,
    queue,
    reservationTtlMs: DEFAULT_RESERVATION_TTL_MS
  });
}

async function startServer() {
  // A porta só abre depois desta consulta. Se o MariaDB estiver indisponível
  // ou devolver estado inválido, admitir com fila vazia criaria overbooking.
  const recovered = await recoverQueueOccupancy();
  console.log(`[game-api] Fila recuperada: ${recovered.accounts} conta(s), ${recovered.connected} conectada(s), ${recovered.reservations} reserva(s).`);

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(PORT, HOST, () => resolve(instance));
    instance.once('error', reject);
  });

  console.log(`[game-api] Rodando em http://${HOST}:${PORT}`);
  scheduleCredentialCleanup({ force: true });
  const manifest = manifestLoader.load();
  if (!manifest.ok) {
    console.warn(`[game-api] ATENCAO: manifesto de mods indisponivel (${manifest.reason}).`);
    console.warn('[game-api] Gere com: node scripts/generate-mods-manifest.js <Data> --plugins-txt <plugins.txt> --build <id> --sequence <n> --key-id <id>');
    console.warn('[game-api] Ate la, /mods.json responde 503 e nenhum jogador consegue entrar.');
  } else {
    console.log(`[game-api] Manifesto v2 assinado: ${manifest.manifest.files.length} arquivos, ${manifest.manifest.loadOrder.length} plugins.`);
  }
  return server;
}

if (require.main === module) {
  let serverInstance = null;
  let shutdownPromise = null;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (serverInstance
      ? new Promise(resolve => serverInstance.close(resolve))
      : Promise.resolve())
      .then(() => pool.end())
      .then(() => console.log(`[game-api] Encerrada por ${signal}.`))
      .catch(error => {
        process.exitCode = 1;
        console.error(`[game-api] Falha no shutdown: ${error.message}`);
      });
    return shutdownPromise;
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  startServer().then(server => {
    serverInstance = server;
  }).catch(async (err) => {
    console.error('[game-api] Boot recusado: nao foi possivel recuperar a fila:', err.message);
    process.exitCode = 1;
    try { await pool.end(); } catch (_) { /* erro original governa o exit code */ }
  });
}

module.exports = {
  app,
  queue,
  consumeLaunchTicket,
  isEligible,
  recoverQueueOccupancy,
  startServer,
  setSessionLeaseServiceForTests,
  setReadinessProbeForTests,
  setMaintenanceForTests
};
