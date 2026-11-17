import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

// ── TLS ───────────────────────────────────────────────────────────────────────
// DB_SSL_MODE decides how the connection is encrypted:
//   verify     TLS, server certificate verified against DB_SSL_CA (or the system
//              trust store). Default in production. Supabase: download the CA from
//              Project Settings → Database → SSL configuration and point DB_SSL_CA at it.
//   no-verify  TLS without certificate verification. Default outside production
//              (local Postgres / the test harness use self-signed certificates).
//              Refused in production (core/config.js productionConfigProblems).
//   disable    no TLS (a local Postgres without SSL).
export const SSL_MODES = ['verify', 'no-verify', 'disable'];

/** The CA bundle from DB_SSL_CA: a PEM string or a path to a PEM file (undefined when unset). */
export function loadCa(value) {
  if (!value) return undefined;
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  return fs.readFileSync(value, 'utf8');
}

/** pg's `ssl` option for a mode. Pure (apart from reading the CA file). */
export function sslOptions({ env, mode, ca }) {
  const m = mode || (env === 'production' ? 'verify' : 'no-verify');
  if (!SSL_MODES.includes(m)) throw new Error(`DB_SSL_MODE must be one of ${SSL_MODES.join(', ')} (got "${m}")`);
  if (m === 'disable') return false;
  if (m === 'no-verify') return { rejectUnauthorized: false };
  const bundle = loadCa(ca);
  return bundle ? { rejectUnauthorized: true, ca: bundle } : { rejectUnauthorized: true };
}

/**
 * ssl* parameters in the URL (sslmode, sslrootcert…) would override the `ssl`
 * option silently (pg merges the parsed URL over the config), so DB_SSL_MODE is
 * the one place TLS is decided: drop them from the connection string.
 */
export function stripSslParams(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (/^ssl/i.test(k)) { u.searchParams.delete(k); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

const SSL = sslOptions({ env: config.env, mode: config.db.sslMode, ca: config.db.sslCa });

function connectionConfig(url) {
  return url
    ? { connectionString: stripSslParams(url) }
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
  // A dead network path fails fast instead of hanging a request or a job past
  // its 5-minute lock (the job would then be reclaimed and run twice).
  connectionTimeoutMillis: config.db.connectTimeoutMs,
  statement_timeout: config.db.statementTimeoutMs,
  allowExitOnIdle: true,
  ssl: SSL,
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
    connectionTimeoutMillis: config.db.connectTimeoutMs,
    ssl: SSL,
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
  let broken;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable: discard it (release(err)) and keep the original error.
      logger.error('ROLLBACK failed — discarding the connection', { error: rollbackErr.message });
      broken = rollbackErr;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    if (CERT_ERRORS.has(err.code)) {
      throw new Error(`Database TLS certificate could not be verified (${err.code}). Set DB_SSL_CA to the `
        + `database's CA certificate (Supabase: Project Settings → Database → SSL configuration → Download certificate).`);
    }
    throw err;
  }
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
  logger.info('Database connection established', { ssl: SSL === false ? 'disabled' : SSL.rejectUnauthorized ? 'verified' : 'unverified' });
}
