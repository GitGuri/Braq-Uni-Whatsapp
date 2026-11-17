/**
 * Versioned migrations against a database built the OLD way (the SQL that
 * db/migrate.js + db/ensureSchema.js used to run — tests/fixtures/legacy-schema.sql)
 * holding legacy rows: every version is applied and recorded, data is intact,
 * a re-run is a no-op, and the API refuses to boot while migrations are pending.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import pg from 'pg';
import { startTestEnv, BACKEND } from '../helpers/env.js';

const FIXTURE = fs.readFileSync(path.join(BACKEND, 'tests', 'fixtures', 'legacy-schema.sql'), 'utf8');
const VERSIONS = fs.readdirSync(path.join(BACKEND, 'src', 'db', 'migrations'))
  .filter(f => /^\d{4,}_[\w-]+\.sql$/.test(f)).map(f => f.slice(0, f.indexOf('_'))).sort();

let env;
let admin;
before(async () => {
  env = await startTestEnv();
  admin = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await admin.connect();
}, { timeout: 240000 });
after(async () => { await admin?.end(); await env?.stop(); });

const childEnv = (databaseUrl) => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  NODE_ENV: 'test', DATABASE_URL: databaseUrl, LOG_LEVEL: 'info', JWT_SECRET: 'x', PORT: '0',
});

/** Run `node src/db/migrate.js` against a database (cwd outside backend so .env is never read). */
function runMigrate(databaseUrl) {
  try {
    const output = execFileSync(process.execPath, [path.join(BACKEND, 'src', 'db', 'migrate.js')], {
      env: childEnv(databaseUrl), cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe', timeout: 120000,
    });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

async function legacyDb(name, prepare) {
  await admin.query(`CREATE DATABASE ${name}`);
  const url = env.databaseUrl.replace(/\/braq_test$/, `/${name}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(FIXTURE);
  if (prepare) await prepare(c);
  return { url, c };
}

async function seedLegacyRows(c) {
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const staff = await one(`INSERT INTO staff (name, email, password_hash, role) VALUES ('Old Admin', 'old@x.test', 'x', 'admin') RETURNING id`);
  const solo = await one(`INSERT INTO clients (whatsapp_number, name, client_type) VALUES ('27820000001', 'Solo Co', 'corporate') RETURNING id`);
  const multi = await one(`INSERT INTO clients (whatsapp_number, name) VALUES ('27820000002', 'Multi') RETURNING id`);
  const quote = await one(
    `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat, total, approved_by)
     VALUES ('BRQ-Q-20250101-0001', $1, 'accepted', '[{"name":"Polo","quantity":10,"lineTotal":1000}]', 1000, 150, 1150, $2) RETURNING id`,
    [solo.id, staff.id]);
  // Legacy 10-stage value — must survive untouched
  const legacyOrder = await one(
    `INSERT INTO orders (reference, client_id, quotation_id, stage, payment_status, deposit_amount, balance_amount)
     VALUES ('BRQ-O-00001', $1, $2, 'manufacturing', 'deposit_paid', 690, 460) RETURNING id`, [solo.id, quote.id]);
  await c.query(`INSERT INTO payments (order_id, type, amount) VALUES ($1, 'deposit', 690)`, [legacyOrder.id]);
  // Order without a quotation: total recovered from balance + max(paid, deposit)
  const bare = await one(
    `INSERT INTO orders (reference, client_id, stage, deposit_amount, balance_amount)
     VALUES ('BRQ-O-00002', $1, 'deposit_pending', 60, 40) RETURNING id`, [multi.id]);
  await c.query(`INSERT INTO orders (reference, client_id, stage) VALUES ('BRQ-O-00003', $1, 'cancelled')`, [multi.id]);
  const soloTicket = await one(
    `INSERT INTO tickets (client_id, category, description, sla_due_at) VALUES ($1, 'defective', 'Seam split on two polos', now()) RETURNING id`, [solo.id]);
  const multiTicket = await one(
    `INSERT INTO tickets (client_id, category, description, sla_due_at) VALUES ($1, 'other', 'Which order is mine?', now()) RETURNING id`, [multi.id]);
  const convo = await one(`INSERT INTO conversations (client_id, state) VALUES ($1, 'main_menu') RETURNING id`, [solo.id]);
  await c.query(`INSERT INTO messages (conversation_id, client_id, body, direction, meta_message_id) VALUES ($1, $2, 'hi', 'inbound', 'wamid.legacy1')`, [convo.id, solo.id]);
  return { legacyOrder, bare, soloTicket, multiTicket };
}

const TABLES = ['staff', 'clients', 'quotations', 'orders', 'payments', 'tickets', 'conversations', 'messages', 'settings', 'sequence_counters'];
async function counts(c) {
  const out = {};
  for (const t of TABLES) out[t] = (await c.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
  return out;
}

test('legacy schema + legacy rows → all versions applied, data intact, re-run is a no-op', async () => {
  let ids;
  const { url, c } = await legacyDb('legacy_upgrade', async (cl) => { ids = await seedLegacyRows(cl); });
  try {
    const before = await counts(c);

    // Boot refuses to start (and runs no DDL) while migrations are pending
    const boot = spawnSync(process.execPath, [path.join(BACKEND, 'src', 'index.js')], {
      env: childEnv(url), cwd: os.tmpdir(), encoding: 'utf8', timeout: 60000,
    });
    assert.equal(boot.status, 1, `index.js should exit 1 with pending migrations:\n${boot.stdout}${boot.stderr}`);
    assert.match(`${boot.stdout}${boot.stderr}`, /pending migration/i);
    assert.equal((await c.query(`SELECT to_regclass('public.schema_migrations')::text AS t`)).rows[0].t, null,
      'boot must not create schema_migrations (no DDL at boot)');

    const first = runMigrate(url);
    assert.ok(first.ok, `migrate failed on the legacy schema:\n${first.output}`);

    const applied = (await c.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(applied.map(r => r.version), VERSIONS);
    // 0009 brings quote-less (legacy) orders into Jobs: one accepted quotation per such order.
    // Every other table keeps its row count.
    assert.deepEqual(await counts(c), { ...before, quotations: before.quotations + 2 }, 'row counts changed');
    const backfilled = (await c.query(
      `SELECT o.reference AS order_ref, q.reference, q.status, q.total, q.line_items
       FROM orders o JOIN quotations q ON q.id = o.quotation_id WHERE o.id = $1`, [ids.bare.id])).rows[0];
    assert.deepEqual([backfilled.reference, backfilled.status, Number(backfilled.total), backfilled.line_items],
      ['BRQ-Q-LEGACY-BRQ-O-00002', 'accepted', 100, []]);
    assert.equal((await c.query('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id IS NULL')).rows[0].n, 0, 'every order is a job');
    const after = await counts(c);

    const legacy = (await c.query('SELECT stage, payment_status, total_amount FROM orders WHERE id = $1', [ids.legacyOrder.id])).rows[0];
    assert.equal(legacy.stage, 'manufacturing', 'legacy stage rows are never rewritten');
    assert.equal(legacy.payment_status, 'deposit_paid');
    assert.equal(Number(legacy.total_amount), 1150, 'total_amount backfilled from the quotation');
    const bare = (await c.query('SELECT total_amount FROM orders WHERE id = $1', [ids.bare.id])).rows[0];
    assert.equal(Number(bare.total_amount), 100, 'total_amount = balance + max(paid, deposit)');

    const solo = (await c.query('SELECT order_id FROM tickets WHERE id = $1', [ids.soloTicket.id])).rows[0];
    assert.equal(solo.order_id, ids.legacyOrder.id, 'ticket linked to the client’s only order');
    const multi = (await c.query('SELECT order_id FROM tickets WHERE id = $1', [ids.multiTicket.id])).rows[0];
    assert.equal(multi.order_id, null, 'ambiguous ticket left unlinked');

    // New tables/columns/constraints are in place
    const cols = new Set((await c.query(`SELECT table_name || '.' || column_name AS col FROM information_schema.columns WHERE table_schema = 'public'`)).rows.map(r => r.col));
    for (const col of ['jobs.dedupe_key', 'inbound_events.meta_message_id', 'orders.total_amount', 'orders.conversation_id',
      'quotations.conversation_id', 'messages.job_id', 'messages.status', 'order_stage_history.override_reason',
      'broadcasts.status', 'tickets.resolution_note', 'clients.account_terms', 'clients.account_terms_set_by', 'messages.sent_by_staff_id']) {
      assert.ok(cols.has(col), `missing ${col}`);
    }
    const checks = (await c.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'orders_%_check' ORDER BY conname`)).rows;
    assert.deepEqual(checks.map(r => [r.conname, r.convalidated]), [
      ['orders_payment_status_check', true], ['orders_proof_status_check', true], ['orders_stage_check', true],
    ]);
    await assert.rejects(c.query(`UPDATE orders SET stage = 'teleporting' WHERE id = $1`, [ids.bare.id]), /orders_stage_check/);
    const idx = new Set((await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map(r => r.indexname));
    for (const i of ['idx_messages_conversation_created', 'idx_orders_created', 'idx_tickets_order']) assert.ok(idx.has(i), `missing index ${i}`);
    assert.ok(!idx.has('idx_orders_reference') && !idx.has('idx_clients_whatsapp'), 'duplicate indexes dropped');

    // Re-run: nothing applied, nothing re-recorded, data unchanged
    const second = runMigrate(url);
    assert.ok(second.ok, second.output);
    assert.deepEqual((await c.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows, applied);
    assert.deepEqual(await counts(c), after);
  } finally {
    await c.end();
  }
});

test('baseline does not fail on a database whose duplicate rows block a unique index', async () => {
  const { url, c } = await legacyDb('legacy_dupes', async (cl) => {
    await cl.query('DROP INDEX uniq_open_conversation_per_client');
    const { rows } = await cl.query(`INSERT INTO clients (whatsapp_number) VALUES ('27830000009') RETURNING id`);
    await cl.query(`INSERT INTO conversations (client_id) VALUES ($1), ($1)`, [rows[0].id]);
  });
  try {
    const r = runMigrate(url);
    assert.ok(r.ok, `migrate must not fail on duplicates:\n${r.output}`);
    assert.match(r.output, /uniq_open_conversation_per_client not created/);
    assert.deepEqual((await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(x => x.version), VERSIONS);
    assert.equal((await c.query(`SELECT COUNT(*)::int AS n FROM conversations`)).rows[0].n, 2, 'duplicates left for a human to resolve');
  } finally {
    await c.end();
  }
});

test('an applied migration that was edited is refused', async () => {
  const { url, c } = await legacyDb('legacy_tamper');
  try {
    assert.ok(runMigrate(url).ok);
    await c.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0002'`);
    const r = runMigrate(url);
    assert.equal(r.ok, false);
    assert.match(r.output, /modified after being applied/);
  } finally {
    await c.end();
  }
});
