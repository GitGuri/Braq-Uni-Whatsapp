// core/db.js with the pg driver replaced by a fake: query wrapper, transaction helper
// (COMMIT / ROLLBACK / release) and testConnection.
import './_setup.js';
import { describe, test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

const state = { poolOpts: null, poolQueries: [], clientQueries: [], released: 0, onHandlers: {}, failOn: null };
class FakePool {
  constructor(opts) { state.poolOpts = opts; }
  on(ev, fn) { state.onHandlers[ev] = fn; }
  async query(text, params) {
    state.poolQueries.push({ text, params });
    if (state.failOn && state.failOn.test(text)) throw new Error('pool boom');
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }
  async connect() {
    return {
      query: async (text, params) => {
        state.clientQueries.push(text);
        if (state.failOn && state.failOn.test(text)) throw new Error(`client boom on ${text}`);
        return { rows: [{ v: 1 }] };
      },
      release: (err) => { state.released++; state.releasedWith = err; },
    };
  }
}

let pool;
before(async () => {
  mock.module('pg', { defaultExport: { Pool: FakePool } });
  pool = await import(src('core/db.js'));
});
beforeEach(() => { state.poolQueries.length = 0; state.clientQueries.length = 0; state.released = 0; state.failOn = null; });

describe('pool configuration', () => {
  test('uses DATABASE_URL with SSL (no cert verification) and pool limits', () => {
    assert.equal(state.poolOpts.connectionString, 'postgresql://x:x@127.0.0.1:1/x');
    assert.deepEqual(state.poolOpts.ssl, { rejectUnauthorized: false });
    assert.equal(state.poolOpts.max, 20);
    assert.equal(state.poolOpts.idleTimeoutMillis, 10000);
    assert.equal(state.poolOpts.allowExitOnIdle, true);
    assert.equal(state.poolOpts.host, undefined);
  });

  test('connection and statement timeouts are set (a hung connection never outlives a job lock)', () => {
    assert.equal(state.poolOpts.connectionTimeoutMillis, 15000);
    assert.equal(state.poolOpts.statement_timeout, 120000);
  });

  test('SEC-3 sslOptions: verify by default in production, no-verify elsewhere, disable on request', () => {
    assert.deepEqual(pool.sslOptions({ env: 'production' }), { rejectUnauthorized: true });
    assert.deepEqual(pool.sslOptions({ env: 'development' }), { rejectUnauthorized: false });
    assert.deepEqual(pool.sslOptions({ env: 'test' }), { rejectUnauthorized: false });
    assert.equal(pool.sslOptions({ env: 'development', mode: 'disable' }), false);
    assert.deepEqual(pool.sslOptions({ env: 'development', mode: 'verify' }), { rejectUnauthorized: true });
    assert.throws(() => pool.sslOptions({ env: 'production', mode: 'sometimes' }), /DB_SSL_MODE/);
  });

  test('SEC-3 the CA is taken from PEM text (escaped newlines allowed) or a file', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----';
    const opts = pool.sslOptions({ env: 'production', ca: pem });
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.ca, '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.tmpdir(), `ca-${process.pid}.pem`);
    fs.writeFileSync(file, 'PEMFILE');
    try {
      assert.equal(pool.sslOptions({ env: 'production', ca: file }).ca, 'PEMFILE');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('SEC-3 ssl* parameters are removed from the URL so DB_SSL_MODE decides', () => {
    assert.equal(pool.stripSslParams('postgresql://u:p@h:5432/db?sslmode=disable&family=4'), 'postgresql://u:p@h:5432/db?family=4');
    assert.equal(pool.stripSslParams('postgresql://u:p@h:5432/db?family=4'), 'postgresql://u:p@h:5432/db?family=4');
    assert.equal(pool.stripSslParams(''), '');
  });

  test('pool error handler is registered and does not throw', () => {
    assert.equal(typeof state.onHandlers.error, 'function');
    state.onHandlers.error(new Error('idle client died'));
  });
});

describe('query()', () => {
  test('passes text/params through and returns the result', async () => {
    const r = await pool.query('SELECT $1', [5]);
    assert.deepEqual(r.rows, [{ ok: 1 }]);
    assert.deepEqual(state.poolQueries[0], { text: 'SELECT $1', params: [5] });
  });

  test('rethrows driver errors', async () => {
    state.failOn = /FAIL/;
    await assert.rejects(pool.query('SELECT FAIL'), /pool boom/);
  });
});

describe('withTransaction()', () => {
  test('BEGIN → fn → COMMIT, returns fn result, releases client', async () => {
    const r = await pool.withTransaction(async (tx) => { await tx.query('INSERT 1'); return 'done'; });
    assert.equal(r, 'done');
    assert.deepEqual(state.clientQueries, ['BEGIN', 'INSERT 1', 'COMMIT']);
    assert.equal(state.released, 1);
  });

  test('fn throws → ROLLBACK, error rethrown, client released', async () => {
    await assert.rejects(pool.withTransaction(async (tx) => { await tx.query('INSERT 1'); throw new Error('app failure'); }), /app failure/);
    assert.deepEqual(state.clientQueries, ['BEGIN', 'INSERT 1', 'ROLLBACK']);
    assert.equal(state.released, 1);
  });

  test('COMMIT failure → ROLLBACK attempted and client released', async () => {
    state.failOn = /^COMMIT$/;
    await assert.rejects(pool.withTransaction(async () => 1), /client boom on COMMIT/);
    assert.deepEqual(state.clientQueries, ['BEGIN', 'COMMIT', 'ROLLBACK']);
    assert.equal(state.released, 1);
  });

  test('BEGIN failure → client still released', async () => {
    state.failOn = /^(BEGIN|ROLLBACK)$/;
    await assert.rejects(pool.withTransaction(async () => 1), /client boom/);
    assert.equal(state.released, 1);
  });

  test('Q-4: a failing ROLLBACK keeps the ORIGINAL error and discards the connection (release(err))', async () => {
    state.failOn = /^(INSERT 9|ROLLBACK)$/;
    await assert.rejects(pool.withTransaction(async (tx) => { await tx.query('INSERT 9'); }), /client boom on INSERT 9/);
    assert.equal(state.released, 1);
    assert.match(String(state.releasedWith?.message), /ROLLBACK/, 'broken client is destroyed, not reused');
  });

  test('a normal rollback returns the connection to the pool (release())', async () => {
    await assert.rejects(pool.withTransaction(async () => { throw new Error('app'); }), /app/);
    assert.equal(state.releasedWith, undefined);
  });
});

describe('testConnection()', () => {
  test('runs SELECT 1 and releases', async () => {
    await pool.testConnection();
    assert.deepEqual(state.clientQueries, ['SELECT 1']);
    assert.equal(state.released, 1);
  });
});
