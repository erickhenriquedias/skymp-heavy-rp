const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./core/migration-runner');

let pool = null;

function init() {
  if (pool) return pool;

  try {
    const configPath = path.resolve(__dirname, '../config/database.local.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Database config file not found at: ${configPath}`);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    pool = mysql.createPool({
      host: config.host || '127.0.0.1',
      port: config.port || 3306,
      user: config.user || 'root',
      password: config.password || '',
      database: config.database || 'skymp_rp',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    console.log('[database] MySQL connection pool initialized successfully');
    return pool;
  } catch (err) {
    console.error('[database] Failed to initialize MySQL pool:', err.message);
    throw err;
  }
}

async function query(sql, params) {
  if (!pool) {
    init();
  }
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getConnection() {
  if (!pool) {
    init();
  }
  return pool.getConnection();
}

/** Confirma que o pool alcança o MariaDB antes de liberar o runtime do jogo. */
async function ping() {
  if (!pool) init();
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

/** Aplica schema/migrations sob lock antes de liberar os modulos do jogo. */
async function migrate(options = {}) {
  const connection = await getConnection();
  try {
    return await runMigrations({ connection, ...options });
  } finally {
    connection.release();
  }
}

/**
 * Fecha o pool e libera o event loop.
 *
 * O servidor de jogo nunca chama isto — ele roda até ser desligado. Quem precisa
 * é script de linha de comando: enquanto o pool existe, o mysql2 mantém sockets
 * abertos e o Node não encerra sozinho.
 *
 * `scripts/verify-governance-market-stalls.js` já chamava `db.close()`, atrás de
 * um `if (typeof db.close === 'function')` — e esta função não existia, então o
 * guard nunca disparava. O resultado era que `RUN_DB_CHECK=1 npm run
 * test:systems` imprimia "10/10 checks passaram" e **ficava pendurado para
 * sempre**, sem devolver o prompt. Num CI com banco, o job só terminaria no
 * timeout, e o relatório diria "cancelado" em vez de "passou".
 */
async function close() {
  if (!pool) return;
  const atual = pool;
  pool = null;
  await atual.end();
}

module.exports = {
  init,
  query,
  getConnection,
  ping,
  migrate,
  close,
  getPool: () => pool
};
