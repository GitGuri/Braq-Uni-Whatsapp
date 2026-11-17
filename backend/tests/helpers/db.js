/**
 * Integration-test database: one throwaway embedded Postgres per test file,
 * with every versioned migration applied, and app modules imported IN-PROCESS
 * against it (no HTTP server, no module mocks).
 *
 * Usage (first import in the file):
 *
 *   import { setupTestDb } from '../helpers/db.js';
 *   const t = await setupTestDb();           // starts PG, sets env, runs migrations
 *   const svc = await t.load('modules/orders/service.js');   // import from backend/src
 *   beforeEach(() => t.reset());              // TRUNCATE everything between tests
 *   after(() => t.stop());
 *
 *   t.sql`...` / t.query(text, params)        // direct queries for arrange/assert
 *   t.wa                                      // fake WhatsApp Graph API (records calls)
 *   t.ai.set(text)                            // what the fake Gemini replies
 *   t.email                                   // fake Resend (records calls)
 *   t.factory.client() / staff() / quotation() / order() / conversation()
 *
 * Isolation: the services use the shared pool and their own transactions, so a
 * per-test rollback is not possible; reset() truncates every table (except
 * schema_migrations) and re-inserts the baseline seed rows instead (~10 ms).
 *
 * Network: everything except localhost is blocked; Meta Graph, Gemini and Resend
 * are answered by nock fakes. process.env never points at the real backend/.env.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import selfsigned from 'selfsigned';
import nock from 'nock';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND = path.resolve(here, '..', '..');
const SRC = path.join(BACKEND, 'src');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const SEED_SQL = `
  INSERT INTO settings (key, value) VALUES ('busy_mode', 'false') ON CONFLICT (key) DO NOTHING;
  INSERT INTO sequence_counters (key, date_key, value) VALUES ('customer', 'global', 0), ('order', 'global', 0)
    ON CONFLICT (key, date_key) DO NOTHING;`;

/**
 * Fake WhatsApp Cloud API: records every send; failNext(n) makes the next n sends return HTTP 500
 * (failNext(n, { status, error }) another answer, e.g. Meta error 131047).
 */
function fakeWhatsApp() {
  const OUTAGE = { status: 500, error: { message: 'fake outage', code: 1 } };
  const state = { calls: [], failures: 0, failWith: OUTAGE, uploads: [], mediaFailures: 0 };
  nock('https://graph.facebook.com')
    .persist()
    .post(/\/messages$/)
    .reply(function (uri, body) {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      if (state.failures > 0) {
        state.failures--;
        state.calls.push({ uri, body: parsed, failed: true });
        return [state.failWith.status, { error: state.failWith.error }];
      }
      const id = `wamid.TEST_${crypto.randomBytes(6).toString('hex')}`;
      state.calls.push({ uri, body: parsed, id });
      return [200, { messaging_product: 'whatsapp', messages: [{ id }] }];
    })
    .post(/\/media$/)
    .reply(function (uri, body) {
      if (state.mediaFailures > 0) { state.mediaFailures--; return [500, { error: { message: 'fake media outage' } }]; }
      // Multipart body: nock hands binary bodies over hex-encoded.
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const text = /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('latin1') : raw;
      state.uploads.push(text);
      return [200, { id: `MEDIA_${state.uploads.length}` }];
    });
  return {
    /** Successful sends: [{ to, type, text?, document?, image?, id }] */
    get sent() { return state.calls.filter((c) => !c.failed).map((c) => ({ ...c.body, id: c.id })); },
    get attempts() { return state.calls.length; },
    /** Raw multipart bodies of successful media uploads (latin1 text). */
    get uploads() { return state.uploads; },
    texts(to) { return this.sent.filter((m) => m.type === 'text' && (!to || m.to === to)).map((m) => m.text.body); },
    documents(to) { return this.sent.filter((m) => m.type === 'document' && (!to || m.to === to)).map((m) => m.document); },
    failNext(n = 1, failWith = OUTAGE) { state.failures = n; state.failWith = { ...OUTAGE, ...failWith }; },
    failNextUpload(n = 1) { state.mediaFailures = n; },
    clear() { state.calls.length = 0; state.failures = 0; state.failWith = OUTAGE; state.uploads.length = 0; state.mediaFailures = 0; },
  };
}

function fakeGemini() {
  let text = '{}';
  const calls = [];
  nock('https://generativelanguage.googleapis.com')
    .persist()
    .post(/.*/)
    .reply(200, (uri, body) => {
      calls.push({ uri, body });
      const t = typeof text === 'function' ? text(body) : text;
      return {
        candidates: [{ content: { role: 'model', parts: [{ text: typeof t === 'string' ? t : JSON.stringify(t) }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      };
    });
  return {
    calls,
    /** Reply text (string, object → JSON, or fn(body) → either). */
    set(t) { text = t; },
    clear() { calls.length = 0; text = '{}'; },
  };
}

function fakeResend() {
  const sent = [];
  nock('https://api.resend.com')
    .persist()
    .post(/.*/)
    .reply(200, (uri, body) => { sent.push(typeof body === 'string' ? JSON.parse(body) : body); return { id: `email_${sent.length}` }; });
  return { sent, clear() { sent.length = 0; } };
}

/**
 * Start the database and point the app at it. Must run before any app module
 * is imported (core/config.js reads process.env at import time).
 */
export async function setupTestDb({ env: extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'braq-int-'));
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048 });
  const key = path.join(root, 'server.key');
  const crt = path.join(root, 'server.crt');
  fs.writeFileSync(key, pems.private);
  fs.writeFileSync(crt, pems.cert);
  const port = await freePort();

  const pg = new EmbeddedPostgres({
    databaseDir: path.join(root, 'pg'),
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
    // core/db.js always connects with SSL, like production (Supabase)
    postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${crt}`, '-c', `ssl_key_file=${key}`],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('braq_int');
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/braq_int`;

  // Never read backend/.env: dotenv looks in cwd.
  process.chdir(root);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    TZ: process.env.TZ || 'Africa/Johannesburg',
    PORT: '0',
    API_BASE_URL: 'http://127.0.0.1:1',
    DATABASE_URL: url,
    DATABASE_DIRECT_URL: '',
    META_APP_ID: 'fake', META_APP_SECRET: '', META_PHONE_NUMBER_ID: '111222333',
    META_WHATSAPP_TOKEN: 'fake', META_WEBHOOK_VERIFY_TOKEN: 'fake_verify', META_API_VERSION: 'v20.0',
    JWT_SECRET: 'test', JWT_EXPIRES_IN: '1h',
    GEMINI_API_KEY: 'fake', RESEND_API_KEY: 're_fake', FROM_EMAIL: 'notifications@test.local',
    NOTIFICATION_OVERRIDE_EMAIL: '', DASHBOARD_BASE_URL: 'http://dash.test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
    WORKER_POLL_MS: '20', JOB_BACKOFF_BASE_MS: '10',
    // The 24-hour WhatsApp window is only enforced by the suites that test it (setupTestDb({ env: { WHATSAPP_WINDOW_CHECK: 'on' } })).
    WHATSAPP_WINDOW_CHECK: 'off',
    ...extraEnv,
  });

  nock.disableNetConnect();
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
  const wa = fakeWhatsApp();
  const ai = fakeGemini();
  const email = fakeResend();

  const load = (p) => import(pathToFileURL(path.join(SRC, p)).href);
  const db = await load('core/db.js');
  const { migrate } = await load('core/migrate.js');
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  await migrate({ log: silent });

  const tables = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  )).rows.map((r) => `"${r.tablename}"`);

  const query = (text, params) => db.pool.query(text, params);
  const one = async (text, params) => (await query(text, params)).rows[0];

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const phone = () => `2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

  const factory = {
    async staff(o = {}) {
      return one(
        `INSERT INTO staff (name, email, password_hash, role, is_active) VALUES ($1,$2,'x',$3,$4) RETURNING *`,
        [o.name ?? 'Staff Member', o.email ?? `s${uniq()}@test.local`, o.role ?? 'consultant', o.is_active ?? true]);
    },
    async client(o = {}) {
      return one(
        `INSERT INTO clients (whatsapp_number, name, client_type, organisation, profile_complete)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [o.whatsapp_number ?? phone(), o.name ?? 'Test Client', o.client_type ?? 'retail', o.organisation ?? null, o.profile_complete ?? true]);
    },
    async quotation(o = {}) {
      const clientId = o.client_id ?? (await factory.client()).id;
      return one(
        `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat, total, valid_until, approved_at, assigned_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [o.reference ?? `BRQ-Q-T${uniq()}`, clientId, o.status ?? 'draft', JSON.stringify(o.line_items ?? []),
         o.subtotal ?? 0, o.vat ?? 0, o.total ?? 0, o.valid_until ?? null, o.approved_at ?? null, o.assigned_staff_id ?? null]);
    },
    async order(o = {}) {
      const clientId = o.client_id ?? (await factory.client()).id;
      return one(
        `INSERT INTO orders (reference, client_id, quotation_id, stage, payment_status, deposit_amount, balance_amount,
                             is_on_hold, hold_reason, proof_status, estimated_completion_date, assigned_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [o.reference ?? `BRQ-O-T${uniq()}`, clientId, o.quotation_id ?? null, o.stage ?? 'deposit_pending',
         o.payment_status ?? 'unpaid', o.deposit_amount ?? null, o.balance_amount ?? null, o.is_on_hold ?? false,
         o.hold_reason ?? null, o.proof_status ?? 'none', o.estimated_completion_date ?? null, o.assigned_staff_id ?? null]);
    },
    async conversation(o = {}) {
      const clientId = o.client_id ?? (await factory.client()).id;
      return one(
        `INSERT INTO conversations (client_id, state, context, is_open, assigned_staff_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [clientId, o.state ?? 'main_menu', JSON.stringify(o.context ?? {}), o.is_open ?? true, o.assigned_staff_id ?? null]);
    },
  };

  /**
   * Run every due job (pending, run_at <= now) through its real handler, in
   * process, until none is left — the integration equivalent of the worker.
   * Failed jobs are rescheduled with backoff (left pending for a later drain)
   * or dead-lettered, exactly as the worker does. Returns per-outcome counts.
   */
  async function drainJobs({ maxRounds = 50 } = {}) {
    const queue = await load('core/queue.js');
    const { handlers } = await load('workers/handlers/index.js');
    const out = { done: 0, retry: 0, dead: 0 };
    for (let round = 0; round < maxRounds; round++) {
      const jobs = await queue.claimBatch(db.pool, 'test-drain', 10);
      if (!jobs.length) return out;
      for (const job of jobs) {
        try {
          const handler = handlers[job.type];
          if (!handler) throw new queue.PermanentJobError(`No handler for job type "${job.type}"`);
          await handler(job.payload || {}, { job });
          await queue.complete(db.pool, job.id);
          out.done++;
        } catch (err) {
          out[await queue.fail(db.pool, job, err)]++;
        }
      }
    }
    throw new Error('drainJobs: jobs keep coming');
  }

  return {
    url,
    load,
    db,
    query,
    one,
    wa,
    ai,
    email,
    factory,
    drainJobs,
    /** Jobs in the queue (optionally of one type), oldest first. */
    async jobs(type) {
      return (await query(`SELECT * FROM jobs ${type ? 'WHERE type = $1' : ''} ORDER BY id`, type ? [type] : [])).rows;
    },
    /** Empty every table (keeps the schema and migration history) and clear the fakes. */
    async reset() {
      await query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE; ${SEED_SQL}`);
      wa.clear();
      ai.clear();
      email.clear();
    },
    async stop() {
      await db.pool.end().catch(() => {});
      nock.cleanAll();
      await pg.stop().catch(() => {});
      process.chdir(os.tmpdir());
      // Windows may hold postgres' files for a moment after it stops; a leftover
      // temp dir is harmless, so never fail the suite over it.
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch { /* left in the OS temp dir */ }
    },
  };
}

/** Strings that must never leak into user-facing text. */
export const BAD_TOKENS = ['undefined', 'null', 'NaN', '[object Object]'];
export function assertClean(assert, text, label = '') {
  assert.equal(typeof text, 'string', `${label}: expected string output`);
  for (const bad of BAD_TOKENS) assert.ok(!text.includes(bad), `${label}: output contains "${bad}":\n${text}`);
}

/**
 * Run fn while a BEFORE trigger on `table` raises an error (simulates a failing
 * write without mocks). `when` is a SQL condition on NEW/OLD/TG_OP.
 */
export async function withFailingTrigger(t, table, fn, { when = 'true', ops = 'INSERT OR UPDATE' } = {}) {
  const name = `test_fail_${table}`;
  await t.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN IF ${when} THEN RAISE EXCEPTION 'simulated % failure on ${table}', TG_OP; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  await t.query(`CREATE TRIGGER ${name} BEFORE ${ops} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await t.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await t.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

/** Run fn while UPDATEs on `table` matching `when` sleep `seconds` (widens race windows deterministically). */
export async function withSlowUpdate(t, table, when, seconds, fn) {
  const name = `test_slow_${table}`;
  await t.query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN IF ${when} THEN PERFORM pg_sleep(${Number(seconds)}); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await t.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await t.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await t.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}
