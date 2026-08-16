const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DATABASE_DIR = path.resolve(__dirname, '..', '..', 'packages', 'database');
const DEFAULT_SCHEMA_PATH = path.join(DEFAULT_DATABASE_DIR, 'schema.sql');
const LOCK_NAME = 'skymp-heavy-rp:schema-migrations';
const MIGRATION_NAME = /^migration-v(\d+)(?:-[a-z0-9-]+)?\.sql$/;

function migrationVersion(name) {
  const match = MIGRATION_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

function discoverMigrations(databaseDir = DEFAULT_DATABASE_DIR) {
  const migrations = fs.readdirSync(databaseDir)
    .map(name => ({ name, version: migrationVersion(name) }))
    .filter(item => item.version !== null)
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error(`nenhuma migration encontrada em ${databaseDir}`);
  }

  for (let index = 0; index < migrations.length; index++) {
    const current = migrations[index];
    const expected = index + 2;
    if (current.version !== expected) {
      throw new Error(
        `cadeia de migrations invalida: esperada v${expected}, encontrada v${current.version} (${current.name})`
      );
    }
  }

  return migrations.map(item => {
    const filePath = path.join(databaseDir, item.name);
    const sql = fs.readFileSync(filePath, 'utf8');
    return {
      ...item,
      path: filePath,
      sql,
      checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
    };
  });
}

/**
 * Divide scripts MySQL/MariaDB sem confundir `;` de strings ou comentarios.
 * Stored routines com DELIMITER nao fazem parte do contrato atual e falham
 * explicitamente, em vez de serem executadas pela metade.
 */
function splitSqlStatements(sql) {
  if (/^\s*DELIMITER\b/im.test(sql)) {
    throw new Error('DELIMITER nao e suportado pelo runner de migrations');
  }

  const statements = [];
  let statement = '';
  let quote = null;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];

    if (quote) {
      statement += char;
      if (char === '\\' && quote !== '`') {
        if (next !== undefined) statement += sql[++index];
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          statement += sql[++index];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      statement += char;
      continue;
    }

    if (char === '#' || (char === '-' && next === '-' && /\s/.test(sql[index + 2] || ''))) {
      while (index < sql.length && sql[index] !== '\n') index++;
      statement += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      index++;
      statement += ' ';
      continue;
    }

    if (char === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      continue;
    }

    statement += char;
  }

  if (quote) throw new Error('string ou identificador SQL sem fechamento');
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function executeScript(connection, sql, label) {
  const statements = splitSqlStatements(sql);
  for (let index = 0; index < statements.length; index++) {
    try {
      await connection.query(statements[index]);
    } catch (error) {
      throw new Error(`${label}: instrucao ${index + 1}/${statements.length} falhou: ${error.message}`, {
        cause: error
      });
    }
  }
}

async function acquireLock(connection, timeoutSeconds) {
  const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, timeoutSeconds]);
  if (Number(rows?.[0]?.acquired) !== 1) {
    throw new Error(`nao foi possivel obter o lock de migrations em ${timeoutSeconds}s`);
  }
}

async function releaseLock(connection) {
  await connection.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
}

async function ensureLedger(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
      \`version\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(191) NOT NULL,
      \`checksum\` CHAR(64) NOT NULL,
      \`duration_ms\` INT UNSIGNED NOT NULL,
      \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`version\`),
      UNIQUE KEY \`uq_schema_migrations_name\` (\`name\`)
    ) ENGINE=InnoDB
  `);
}

async function bootstrapSchemaIfEmpty(connection, schemaPath) {
  const [rows] = await connection.query(`
    SELECT COUNT(*) AS table_count
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME <> 'schema_migrations'
  `);
  const tableCount = Number(rows?.[0]?.table_count || 0);
  if (tableCount > 0) return false;

  if (!fs.existsSync(schemaPath)) throw new Error(`schema base nao encontrado: ${schemaPath}`);
  await executeScript(connection, fs.readFileSync(schemaPath, 'utf8'), path.basename(schemaPath));
  return true;
}

async function loadApplied(connection) {
  const [rows] = await connection.query(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
  );
  return new Map(rows.map(row => [Number(row.version), row]));
}

function validateApplied(migrations, applied) {
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]));
  for (const [version, row] of applied) {
    const migration = byVersion.get(version);
    if (!migration) {
      throw new Error(`migration aplicada v${version} (${row.name}) nao existe mais no repositorio`);
    }
    if (row.name !== migration.name) {
      throw new Error(`migration v${version} foi renomeada: banco=${row.name}, arquivo=${migration.name}`);
    }
    if (row.checksum !== migration.checksum) {
      throw new Error(`checksum divergente na migration v${version} (${migration.name})`);
    }
  }
}

async function runMigrations({
  connection,
  databaseDir = DEFAULT_DATABASE_DIR,
  schemaPath = DEFAULT_SCHEMA_PATH,
  lockTimeoutSeconds = 30,
  logger = console
}) {
  if (!connection || typeof connection.query !== 'function') {
    throw new TypeError('connection MariaDB valida e obrigatoria');
  }

  const migrations = discoverMigrations(databaseDir);
  let locked = false;
  let primaryError = null;
  try {
    await acquireLock(connection, lockTimeoutSeconds);
    locked = true;

    const bootstrapped = await bootstrapSchemaIfEmpty(connection, schemaPath);
    await ensureLedger(connection);

    const applied = await loadApplied(connection);
    validateApplied(migrations, applied);

    const newlyApplied = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      const startedAt = Date.now();
      await executeScript(connection, migration.sql, migration.name);
      const durationMs = Math.max(0, Date.now() - startedAt);
      await connection.query(
        `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
         VALUES (?, ?, ?, ?)`,
        [migration.version, migration.name, migration.checksum, durationMs]
      );
      newlyApplied.push(migration.name);
      logger.log(`[migrations] aplicada ${migration.name} (${durationMs}ms)`);
    }

    return {
      bootstrapped,
      discovered: migrations.length,
      applied: newlyApplied,
      currentVersion: migrations[migrations.length - 1].version
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (locked) {
      try {
        await releaseLock(connection);
      } catch (error) {
        logger.error(`[migrations] falha ao liberar lock: ${error.message}`);
        // Named locks pertencem a sessao. Devolver esta conexao viva ao pool
        // poderia manter o deploy inteiro bloqueado indefinidamente.
        if (typeof connection.destroy === 'function') connection.destroy();
        if (!primaryError) {
          throw new Error(`migration concluida, mas o lock nao foi liberado: ${error.message}`, {
            cause: error
          });
        }
      }
    }
  }
}

module.exports = {
  LOCK_NAME,
  migrationVersion,
  discoverMigrations,
  splitSqlStatements,
  executeScript,
  validateApplied,
  runMigrations
};
