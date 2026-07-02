import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const poolConfig = config.db.url
  ? {
      connectionString: config.db.url,
    }
  : {
      host:     config.db.host,
      port:     config.db.port,
      database: config.db.name,
      user:     config.db.user,
      password: config.db.password,
    };

export const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

// Convenience query wrapper with logging
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('DB query executed', { duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('DB query failed', { error: err.message, query: text });
    throw err;
  }
}

// Transaction helper
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection() {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  logger.info('Database connection established');
}
