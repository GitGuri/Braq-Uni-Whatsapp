// core/db.js and core/migrate.js against a real Postgres.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const db = await t.load('core/db.js');
const migrator = await t.load('core/migrate.js');

beforeEach(() => t.reset());
after(() => t.stop());

describe('core/db', () => {
  test('query passes params through', async () => {
    const { rows } = await db.query('SELECT $1::int + 1 AS n', [41]);
    assert.equal(rows[0].n, 42);
  });

  test('query rethrows driver errors with the Postgres code', async () => {
    await assert.rejects(db.query('SELECT * FROM no_such_table'), (e) => e.code === '42P01');
  });

  test('withTransaction commits and returns the callback result', async () => {
    const r = await db.withTransaction(async (tx) => {
      await tx.query(`INSERT INTO settings (key, value) VALUES ('tx_ok', '1')`);
      return 'done';
    });
    assert.equal(r, 'done');
    assert.equal((await t.one(`SELECT value FROM settings WHERE key = 'tx_ok'`)).value, '1');
  });

  test('withTransaction rolls back everything when the callback throws', async () => {
    await assert.rejects(db.withTransaction(async (tx) => {
      await tx.query(`INSERT INTO settings (key, value) VALUES ('tx_bad', '1')`);
      throw new Error('app failure');
    }), /app failure/);
    assert.equal(await t.one(`SELECT 1 FROM settings WHERE key = 'tx_bad'`), undefined);
  });

  test('clients are released (many transactions do not exhaust the pool)', async () => {
    for (let i = 0; i < 30; i++) await db.withTransaction((tx) => tx.query('SELECT 1')).catch(() => {});
    await Promise.all(Array.from({ length: 30 }, () => db.withTransaction(async () => { throw new Error('x'); }).catch(() => {})));
    assert.equal(db.pool.waitingCount, 0);
    await db.testConnection();
  });

  test('connectDirect gives a dedicated client (LISTEN/NOTIFY works on it)', async () => {
    const c = await db.connectDirect();
    try {
      const got = new Promise((resolve) => c.on('notification', (n) => resolve(n)));
      await c.query('LISTEN test_channel');
      await db.query(`SELECT pg_notify('test_channel', 'hello')`);
      const n = await got;
      assert.deepEqual([n.channel, n.payload], ['test_channel', 'hello']);
    } finally {
      await c.end();
    }
  });
});

describe('core/migrate', () => {
  test('nothing pending after setup; assertSchemaUpToDate passes', async () => {
    assert.deepEqual(await migrator.pendingMigrations(), []);
    await migrator.assertSchemaUpToDate();
  });

  test('a new file on disk is reported pending, then applied once by migrate()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braq-mig-'));
    for (const f of fs.readdirSync(migrator.MIGRATIONS_DIR)) fs.copyFileSync(path.join(migrator.MIGRATIONS_DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '9999_test_extra.sql'), 'CREATE TABLE IF NOT EXISTS test_extra (id int);\r\n');
    const silent = { info() {}, warn() {}, error() {}, debug() {} };
    try {
      assert.deepEqual((await migrator.pendingMigrations({ dir })).map((p) => p.version), ['9999']);
      await assert.rejects(migrator.assertSchemaUpToDate({ dir }), /1 pending migration\(s\): 9999_test_extra\.sql/);
      const r = await migrator.migrate({ dir, log: silent });
      assert.deepEqual(r.applied, ['9999']);
      assert.ok(await t.one(`SELECT to_regclass('public.test_extra') AS t`));
      assert.deepEqual((await migrator.migrate({ dir, log: silent })).applied, []);
      // CRLF and LF checkouts of the same file have the same checksum
      fs.writeFileSync(path.join(dir, '9999_test_extra.sql'), 'CREATE TABLE IF NOT EXISTS test_extra (id int);\n');
      assert.deepEqual(await migrator.pendingMigrations({ dir }), []);
    } finally {
      await t.query('DROP TABLE IF EXISTS test_extra');
      await t.query(`DELETE FROM schema_migrations WHERE version = '9999'`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failing migration is rolled back and not recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braq-mig-'));
    for (const f of fs.readdirSync(migrator.MIGRATIONS_DIR)) fs.copyFileSync(path.join(migrator.MIGRATIONS_DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '9998_broken.sql'), 'CREATE TABLE test_half (id int);\nSELECT * FROM missing_table;\n');
    try {
      await assert.rejects(migrator.migrate({ dir, log: { info() {}, warn() {} } }), /9998_broken\.sql failed/);
      assert.equal((await t.one(`SELECT to_regclass('public.test_half')::text AS t`)).t, null, 'partial DDL rolled back');
      assert.equal(await t.one(`SELECT 1 FROM schema_migrations WHERE version = '9998'`), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('splitStatements handles no-transaction files', () => {
    assert.deepEqual(migrator.splitStatements('-- migrate:no-transaction\n-- note\nCREATE INDEX a ON t (x);\nDROP INDEX IF EXISTS b;\n'),
      ['CREATE INDEX a ON t (x)', 'DROP INDEX IF EXISTS b']);
  });
});
