/**
 * Versioned migration runner.
 *
 * Files: src/db/migrations/NNNN_name.sql, applied in version order and recorded
 * in schema_migrations(version, name, checksum, applied_at).
 *  - A session advisory lock (hashtext('braq:migrate')) makes concurrent runs
 *    wait for each other, so two deploys never apply the same file twice.
 *  - Each file runs in its own transaction with lock_timeout = 5s. A file whose
 *    first line is `-- migrate:no-transaction` (needed for CREATE INDEX
 *    CONCURRENTLY) runs statement by statement outside a transaction; such
 *    files must not use dollar-quoting and must end each statement with `;`
 *    at the end of a line.
 *  - An applied file whose checksum has changed is an error: never edit an
 *    applied migration — add a new one.
 *
 * Server boot never runs DDL: index.js only calls pendingMigrations() and exits
 * when anything is pending. Deploy step: `npm run migrate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectDirect, query as poolQuery } from './db.js';
import { logger } from './logger.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const LOCK_KEY = 'braq:migrate';
const LOCK_TIMEOUT = '5s';
const FILE_RE = /^(\d{4,})_([\w-]+)\.sql$/;

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT        PRIMARY KEY,
  name       TEXT        NOT NULL,
  checksum   TEXT        NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** All migration files on disk, sorted by version: [{ version, name, file, sql, checksum, transactional }]. */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = FILE_RE.exec(file);
      // Normalise line endings so a CRLF checkout has the same checksum.
      const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return {
        version,
        name,
        file,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
        transactional: !/^\s*--\s*migrate:no-transaction\b/.test(sql),
      };
    });
}

/** Split a no-transaction file into statements (no dollar-quoting allowed there). */
export function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appliedRows(client) {
  const { rows: exists } = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!exists[0].t) return new Map();
  const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.version, r]));
}

function checkChecksums(files, applied) {
  const changed = files.filter((f) => applied.has(f.version) && applied.get(f.version).checksum !== f.checksum);
  if (changed.length) {
    throw new Error(`Applied migration(s) were modified after being applied: ${changed.map((f) => f.file).join(', ')}. ` +
      'Never edit an applied migration — add a new one.');
  }
}

/**
 * Versions on disk not yet recorded in schema_migrations. Uses the shared pool
 * (read-only); throws when an applied file's checksum changed.
 */
export async function pendingMigrations({ db = { query: poolQuery }, dir = MIGRATIONS_DIR } = {}) {
  const files = listMigrationFiles(dir);
  const applied = await appliedRows(db);
  checkChecksums(files, applied);
  return files.filter((f) => !applied.has(f.version)).map(({ version, name, file }) => ({ version, name, file }));
}

/**
 * Apply every pending migration. Returns { applied: [versions], total }.
 * @param {{ dir?: string, log?: object, client?: import('pg').Client }} [opts]
 *   client: an already-connected pg client to use (the caller keeps ownership).
 */
export async function migrate({ dir = MIGRATIONS_DIR, log = logger, client: given } = {}) {
  const files = listMigrationFiles(dir);
  const client = given || await connectDirect();
  // Surface RAISE NOTICE from migrations (e.g. a skipped unique index) in the log.
  const onNotice = (n) => log.warn(`migration notice: ${n.message}`);
  client.on('notice', onNotice);
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    try {
      await client.query(CREATE_TABLE);
      const done = await appliedRows(client);
      checkChecksums(files, done);

      for (const m of files) {
        if (done.has(m.version)) continue;
        log.info(`Applying migration ${m.file}`);
        const record = () => client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum]
        );
        if (m.transactional) {
          await client.query('BEGIN');
          try {
            await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
            await client.query(m.sql);
            await record();
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`Migration ${m.file} failed: ${err.message}`);
          }
        } else {
          await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
          try {
            for (const stmt of splitStatements(m.sql)) await client.query(stmt);
            await record();
          } catch (err) {
            throw new Error(`Migration ${m.file} failed: ${err.message}`);
          } finally {
            await client.query('RESET lock_timeout').catch(() => {});
          }
        }
        applied.push(m.version);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    }
    log.info(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database schema is up to date');
    return { applied, total: files.length };
  } finally {
    client.removeListener('notice', onNotice);
    if (!given) await client.end().catch(() => {});
  }
}

/** Boot guard: throws a clear error when migrations are pending. */
export async function assertSchemaUpToDate(opts) {
  const pending = await pendingMigrations(opts);
  if (pending.length) {
    const err = new Error(`Database schema is out of date — ${pending.length} pending migration(s): ` +
      `${pending.map((p) => p.file).join(', ')}. Run \`npm run migrate\` before starting the server.`);
    err.pending = pending;
    throw err;
  }
}
