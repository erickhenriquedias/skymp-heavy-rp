const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');

const {
  discoverMigrations,
  runMigrations,
  splitSqlStatements
} = require('./migration-runner');

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skymp-migrations-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

class FakeConnection {
  constructor({ tableCount = 1, lock = 1, releaseError = false } = {}) {
    this.tableCount = tableCount;
    this.lock = lock;
    this.releaseError = releaseError;
    this.ledger = [];
    this.executed = [];
    this.failOn = null;
    this.destroyed = false;
  }

  destroy() { this.destroyed = true; }

  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT GET_LOCK')) return [[{ acquired: this.lock }], []];
    if (normalized.startsWith('SELECT RELEASE_LOCK')) {
      if (this.releaseError) throw new Error('conexao perdida');
      return [[{ released: 1 }], []];
    }
    if (normalized.includes('FROM information_schema.TABLES')) {
      return [[{ table_count: this.tableCount }], []];
    }
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS `schema_migrations`')) return [{}, []];
    if (normalized.startsWith('SELECT version, name, checksum FROM schema_migrations')) {
      return [this.ledger.map(row => ({ ...row })), []];
    }
    if (normalized.startsWith('INSERT INTO schema_migrations')) {
      this.ledger.push({ version: params[0], name: params[1], checksum: params[2] });
      return [{ affectedRows: 1 }, []];
    }
    if (this.failOn && normalized.includes(this.failOn)) throw new Error('falha simulada');
    this.executed.push(normalized);
    return [{}, []];
  }
}

const silentLogger = { log() {}, error() {} };

describe('splitSqlStatements', () => {
  test('ignora ponto e virgula em strings e comentarios', () => {
    const statements = splitSqlStatements(`
      -- comentario; nao e statement
      CREATE TABLE \`one\` (\`value\` VARCHAR(30) COMMENT 'a;b');
      # outro; comentario
      INSERT INTO \`one\` VALUES ('x; y'); /* bloco; comentario */
    `);
    assert.deepEqual(statements, [
      "CREATE TABLE `one` (`value` VARCHAR(30) COMMENT 'a;b')",
      "INSERT INTO `one` VALUES ('x; y')"
    ]);
  });

  test('recusa DELIMITER em vez de truncar stored routine', () => {
    assert.throws(() => splitSqlStatements('DELIMITER //\nCREATE PROCEDURE p() SELECT 1//'), /DELIMITER/);
  });
});

describe('discoverMigrations', () => {
  test('todos os scripts SQL versionados usam sintaxe suportada pelo parser', () => {
    const databaseDir = path.resolve(__dirname, '..', '..', 'packages', 'database');
    const files = ['schema.sql', ...discoverMigrations(databaseDir).map(item => item.name)];
    for (const name of files) {
      const statements = splitSqlStatements(fs.readFileSync(path.join(databaseDir, name), 'utf8'));
      assert.ok(statements.length > 0, `${name} nao produziu instrucoes SQL`);
    }
  });

  test('ordena numericamente e exige cadeia continua a partir da v2', () => {
    const dir = fixture({
      'migration-v3-three.sql': 'SELECT 3;',
      'migration-v2.sql': 'SELECT 2;',
      'migration-v4-four.sql': 'SELECT 4;',
      'schema.sql': 'SELECT 1;'
    });
    assert.deepEqual(discoverMigrations(dir).map(item => item.version), [2, 3, 4]);
  });

  test('falha quando uma versao esta ausente', () => {
    const dir = fixture({
      'migration-v2.sql': 'SELECT 2;',
      'migration-v4-four.sql': 'SELECT 4;'
    });
    assert.throws(() => discoverMigrations(dir), /esperada v3, encontrada v4/);
  });
});

describe('runMigrations', () => {
  test('o boot conclui migrations antes de inicializar os modulos', () => {
    const bootSource = fs.readFileSync(path.resolve(__dirname, '..', 'phase0-basic.js'), 'utf8');
    const migrateAt = bootSource.indexOf('await db.migrate()');
    const modulesAt = bootSource.indexOf('await moduleRegistry.bootAll()');
    assert.ok(migrateAt >= 0, 'phase0-basic.js nao chama db.migrate()');
    assert.ok(modulesAt > migrateAt, 'modulos foram inicializados antes das migrations');
  });

  test('aplica em ordem e o replay nao executa migration novamente', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'SELECT 2;',
      'migration-v3-three.sql': 'SELECT 3;'
    });
    const connection = new FakeConnection();

    const first = await runMigrations({
      connection,
      databaseDir: dir,
      schemaPath: path.join(dir, 'schema.sql'),
      logger: silentLogger
    });
    const second = await runMigrations({
      connection,
      databaseDir: dir,
      schemaPath: path.join(dir, 'schema.sql'),
      logger: silentLogger
    });

    assert.deepEqual(connection.executed, ['SELECT 2', 'SELECT 3']);
    assert.deepEqual(first.applied, ['migration-v2.sql', 'migration-v3-three.sql']);
    assert.deepEqual(second.applied, []);
    assert.equal(connection.ledger.length, 2);
  });

  test('retoma da migration que falhou sem repetir a anterior', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'SELECT 2;',
      'migration-v3-three.sql': 'BROKEN;'
    });
    const connection = new FakeConnection();
    connection.failOn = 'BROKEN';

    await assert.rejects(
      runMigrations({ connection, databaseDir: dir, schemaPath: path.join(dir, 'schema.sql'), logger: silentLogger }),
      /migration-v3-three\.sql.*falha simulada/
    );
    assert.deepEqual(connection.ledger.map(row => row.version), [2]);

    connection.failOn = null;
    await runMigrations({
      connection,
      databaseDir: dir,
      schemaPath: path.join(dir, 'schema.sql'),
      logger: silentLogger
    });
    assert.deepEqual(connection.executed, ['SELECT 2', 'BROKEN']);
    assert.deepEqual(connection.ledger.map(row => row.version), [2, 3]);
  });

  test('falha fechado se arquivo aplicado mudou de checksum', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'SELECT 2;'
    });
    const connection = new FakeConnection();
    await runMigrations({
      connection,
      databaseDir: dir,
      schemaPath: path.join(dir, 'schema.sql'),
      logger: silentLogger
    });

    fs.writeFileSync(path.join(dir, 'migration-v2.sql'), 'SELECT 200;');
    await assert.rejects(
      runMigrations({ connection, databaseDir: dir, schemaPath: path.join(dir, 'schema.sql'), logger: silentLogger }),
      /checksum divergente/
    );
  });

  test('banco vazio recebe schema antes das migrations', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'ALTER TABLE base ADD value INT;'
    });
    const connection = new FakeConnection({ tableCount: 0 });
    const result = await runMigrations({
      connection,
      databaseDir: dir,
      schemaPath: path.join(dir, 'schema.sql'),
      logger: silentLogger
    });

    assert.equal(result.bootstrapped, true);
    assert.deepEqual(connection.executed, [
      'CREATE TABLE base (id INT)',
      'ALTER TABLE base ADD value INT'
    ]);
  });

  test('nao executa nada sem obter o lock exclusivo', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'SELECT 2;'
    });
    const connection = new FakeConnection({ lock: 0 });
    await assert.rejects(
      runMigrations({ connection, databaseDir: dir, schemaPath: path.join(dir, 'schema.sql'), logger: silentLogger }),
      /obter o lock/
    );
    assert.deepEqual(connection.executed, []);
  });

  test('destroi a sessao e bloqueia o boot se nao conseguir liberar o lock', async () => {
    const dir = fixture({
      'schema.sql': 'CREATE TABLE base (id INT);',
      'migration-v2.sql': 'SELECT 2;'
    });
    const connection = new FakeConnection({ releaseError: true });
    await assert.rejects(
      runMigrations({ connection, databaseDir: dir, schemaPath: path.join(dir, 'schema.sql'), logger: silentLogger }),
      /lock nao foi liberado/
    );
    assert.equal(connection.destroyed, true);
  });
});
