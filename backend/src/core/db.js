import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

function connectionConfig(url) {
  return url
    ? { connectionString: url }
    : {
        host:     config.db.host,
        port:     config.db.port,
        database: config.db.name,
        user:     config.db.user,
        password: config.db.password,
      };
}

export const pool = new Pool({
  ...connectionConfig(config.db.url),
  max: 20,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});

/**
 * A single dedicated client on the direct (non-pooler) URL when DATABASE_DIRECT_URL
 * is set — used for LISTEN/NOTIFY and session advisory locks, which Supabase's
 * transaction pooler does not support. Falls back to the main URL.
 * The caller owns the client (call .end()).
 */
export async function connectDirect() {
  const client = new pg.Client({
    ...connectionConfig(config.db.directUrl || config.db.url),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

export const hasDirectUrl = () => Boolean(config.db.directUrl);

// Convenience query wrapper. Logs timing at debug; on failure logs the error
// and the statement's first line only (never the parameters — they carry PII).
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    logger.debug('DB query executed', { duration: Date.now() - start, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('DB query failed', { error: err.message, code: err.code, query: String(text).trim().split('\n')[0].slice(0, 120) });
    throw err;
  }
}

// Transaction helper: fn(client) runs between BEGIN and COMMIT; any throw rolls back.
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
