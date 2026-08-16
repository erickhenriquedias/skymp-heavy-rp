const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { runMigrations } = require('./core/migration-runner');

async function run() {
  const configPath = path.resolve(__dirname, '../config/database.local.json');
  const schemaPath = path.resolve(__dirname, '../packages/database/schema.sql');

  if (!fs.existsSync(configPath)) {
    console.error(`Error: config file not found at ${configPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(schemaPath)) {
    console.error(`Error: schema file not found at ${schemaPath}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`Attempting to connect to MySQL at ${config.host}:${config.port} as ${config.user}...`);

  let connection;
  try {
    if ((config.database || 'skymp_rp') !== 'skymp_rp') {
      throw new Error('database.local.json deve apontar para o banco oficial skymp_rp');
    }

    // Conecta sem database para conseguir criar o banco no primeiro setup.
    connection = await mysql.createConnection({
      host: config.host || '127.0.0.1',
      port: config.port || 3306,
      user: config.user || 'root',
      password: config.password || ''
    });

    try {
      await connection.query('USE `skymp_rp`');
    } catch (error) {
      if (error.code !== 'ER_BAD_DB_ERROR') throw error;
      await connection.query(
        'CREATE DATABASE IF NOT EXISTS `skymp_rp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
      );
      await connection.query('USE `skymp_rp`');
    }

    const result = await runMigrations({ connection, schemaPath });
    console.log(
      `Database ready at migration v${result.currentVersion} ` +
      `(${result.applied.length} applied now).`
    );
  } catch (err) {
    console.error('Failed to set up database:', err.message);
    console.log('\n--- Troubleshooting ---');
    console.log('Please make sure your MySQL/MariaDB server is running and the credentials in skymp/config/database.local.json are correct.');
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

run();
