import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { startTestEnv, BACKEND } from '../helpers/env.js';

let env;
let db;
before(async () => {
  env = await startTestEnv();
  db = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
}, { timeout: 240000 });
after(async () => { await db?.end(); await env?.stop(); });

const count = async (table) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n);

/** Run a src/db script against an arbitrary database (cwd outside backend so the real .env is never read). */
function runAgainst(databaseUrl, script) {
  try {
    execFileSync(process.execPath, [path.join(BACKEND, 'src', 'db', script)], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: databaseUrl, LOG_LEVEL: 'error' },
      cwd: os.tmpdir(), stdio: 'pipe', timeout: 120000,
    });
    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('seed-catalog.js runs on a freshly migrated database', () => {
  const r = env.runDbScript('seed-catalog.js');
  assert.ok(r.ok, `seed-catalog.js failed:\n${r.output}`);
});

test('seed-testing.js populates demo data and is safe to re-run', async () => {
  const first = env.runDbScript('seed-testing.js');
  assert.ok(first.ok, `first run failed:\n${first.output}`);
  const counts = {};
  for (const t of ['staff', 'clients', 'orders', 'quotations', 'tickets']) counts[t] = await count(t);
  for (const [t, n] of Object.entries(counts)) assert.ok(n > 0, `${t} should have rows after seed-testing`);

  const second = env.runDbScript('seed-testing.js');
  assert.ok(second.ok, `second run failed:\n${second.output}`);
  for (const [t, n] of Object.entries(counts)) assert.equal(await count(t), n, `${t} count changed on re-run`);
});

test('repo scripts create every table the code queries', async () => {
  const { rows } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const have = new Set(rows.map(r => r.table_name));
  // Used by purchaseOrders.service.js, schoolCatalog.service.js, sizes.service.js, backfill-needs-review.js
  const missing = ['purchase_orders', 'school_catalog', 'order_size_entries'].filter(t => !have.has(t));
  assert.deepEqual(missing, [], `tables never created by the migrations: ${missing.join(', ')}`);
});

test('backfill-needs-review.js runs and is idempotent', async () => {
  const a = env.runDbScript('backfill-needs-review.js');
  assert.ok(a.ok, a.output);
  const flagged = (await db.query('SELECT id FROM orders WHERE needs_review ORDER BY id')).rows;
  const b = env.runDbScript('backfill-needs-review.js');
  assert.ok(b.ok, b.output);
  assert.deepEqual((await db.query('SELECT id FROM orders WHERE needs_review ORDER BY id')).rows, flagged);
});

test('every migration file is recorded once; a second migrate applies 0 migrations', async () => {
  const files = fs.readdirSync(path.join(BACKEND, 'src', 'db', 'migrations')).filter(f => /^\d{4,}_[\w-]+\.sql$/.test(f));
  assert.ok(files.length >= 6, `expected the versioned migrations, found ${files.join(', ')}`);
  const before = (await db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(before.map(r => r.version), files.map(f => f.slice(0, f.indexOf('_'))).sort());
  const r = env.runDbScript('migrate.js');
  assert.ok(r.ok, r.output);
  const after = (await db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(after, before, 'second migrate must not apply or re-record anything');
});

test('the job queue tables exist (jobs, inbound_events)', async () => {
  const { rows } = await db.query(`SELECT to_regclass('public.jobs')::text AS jobs, to_regclass('public.inbound_events')::text AS events`);
  assert.equal(rows[0].jobs, 'jobs');
  assert.equal(rows[0].events, 'inbound_events');
});

test('README setup (migrate + seed only) gives a schema with every column the code uses', async () => {
  await db.query('CREATE DATABASE readme_setup');
  const url = env.databaseUrl.replace(/\/braq_test$/, '/readme_setup');
  for (const s of ['migrate.js', 'seed.js']) {
    const r = runAgainst(url, s);
    assert.ok(r.ok, `${s} failed:\n${r.output}`);
  }
  const other = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await other.connect();
  try {
    const { rows } = await other.query(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns WHERE table_schema = 'public'`);
    const have = new Set(rows.map(r => r.col));
    // Columns queried by the reminder.scan job and the claim/notify flow
    const needed = ['quotations.notified_at', 'quotations.staff_reminder_sent_at', 'quotations.claimed_at',
      'tickets.notified_at', 'tickets.claimed_at', 'conversations.notified_at'];
    const missing = needed.filter(c => !have.has(c));
    assert.deepEqual(missing, [], `columns missing after README setup: ${missing.join(', ')}`);
  } finally {
    await other.end();
  }
});

test('re-running migrate.js keeps existing data', async () => {
  const before = await count('staff');
  assert.ok(before > 0);
  const r = env.runDbScript('migrate.js');
  assert.ok(r.ok, r.output);
  assert.equal(await count('staff'), before, 'migrate.js wiped the staff table (it starts with DROP TABLE ... CASCADE)');
});
