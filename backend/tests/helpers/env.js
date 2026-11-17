/**
 * Test environment: a throwaway local Postgres (with SSL, because pool.js
 * always connects with SSL) plus a running API server wired to fakes.
 *
 * Child processes run with cwd set to a temp dir so dotenv can never load
 * the real backend/.env, and every external credential is a dummy value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pgLib from 'pg';
import selfsigned from 'selfsigned';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND = path.resolve(here, '..', '..');

export const ADMIN = { email: 'admin@test.local', password: 'AdminPass123!', name: 'Test Admin' };
export const JWT_SECRET = 'test_jwt_secret';
export const VERIFY_TOKEN = 'test_verify_token';

const debug = process.env.TEST_DEBUG ? (...a) => console.error('[test-env]', ...a) : () => {};

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

async function makeCert(dir) {
  const key = path.join(dir, 'server.key');
  const crt = path.join(dir, 'server.crt');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 2, keySize: 2048 });
  fs.writeFileSync(key, pems.private);
  fs.writeFileSync(crt, pems.cert);
  return { key, crt };
}

function runScript(script, env, cwd) {
  execFileSync(process.execPath, [path.join(BACKEND, 'src', 'db', script)], {
    env, cwd, stdio: 'pipe', timeout: 120000,
  });
}

// migrate.js applies the versioned migrations (src/db/migrations); seed.js creates the admin.
const SETUP_SCRIPTS = ['migrate.js', 'seed.js'];

export async function startTestEnv({ seedTestingData = false, env: extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'braq-test-'));
  const { key, crt } = await makeCert(root);
  const pgPort = await freePort();

  const pg = new EmbeddedPostgres({
    databaseDir: path.join(root, 'pg'),
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    // Match Supabase: UTF-8. On Windows initdb otherwise defaults to WIN1252, which rejects emoji.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: m => debug(String(m).trim()),
    onError: m => debug(String(m).trim()),
    postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${crt}`, '-c', `ssl_key_file=${key}`],
  });

  let server = null;
  const teardown = async () => {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise(r => (server.exitCode !== null ? r() : server.once('exit', r)));
    }
    await pg.stop().catch(() => {});
    // Windows may hold postgres' files for a moment after it stops; a leftover
    // temp dir is harmless, so never fail a suite over it.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch { /* left in the OS temp dir */ }
  };

  try {
    debug('initdb');
    await pg.initialise();
    debug('start postgres');
    await pg.start();
    await pg.createDatabase('braq_test');

    const fakeLog = path.join(root, 'fakes.jsonl');
    const aiFile = path.join(root, 'ai.json');
    const waFailFile = path.join(root, 'wa-fail.txt');
    fs.writeFileSync(fakeLog, '');
    fs.writeFileSync(waFailFile, '0');
    fs.writeFileSync(aiFile, JSON.stringify({ text: '{}' }));

    const apiPort = await freePort();
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'test',
      PORT: String(apiPort),
      API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/braq_test`,
      META_APP_ID: 'fake', META_APP_SECRET: 'fake', META_PHONE_NUMBER_ID: '000000',
      META_WHATSAPP_TOKEN: 'fake', META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN, META_API_VERSION: 'v19.0',
      JWT_SECRET, JWT_EXPIRES_IN: '1h',
      GEMINI_API_KEY: 'fake', RESEND_API_KEY: 're_fake', FROM_EMAIL: 'test@test.local',
      NOTIFICATION_OVERRIDE_EMAIL: '', DASHBOARD_BASE_URL: 'http://127.0.0.1:5173',
      LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
      SEED_ADMIN_NAME: ADMIN.name, SEED_ADMIN_EMAIL: ADMIN.email, SEED_ADMIN_PASSWORD: ADMIN.password,
      FAKE_LOG: fakeLog, FAKE_AI_FILE: aiFile, FAKE_WA_FAIL: waFailFile,
      // Job worker runs inside the API process, polling fast so tests don't wait.
      WORKER_IN_PROCESS: 'true', WORKER_POLL_MS: '50', BROADCAST_RATE_PER_SEC: '1000',
      // The 24-hour WhatsApp window is only enforced by the suites that test it ({ env: { WHATSAPP_WINDOW_CHECK: 'on' } }).
      WHATSAPP_WINDOW_CHECK: 'off',
      ...extraEnv,
    };

    // Scripts get the network block too, in case any of them reach out.
    const fakesUrl = new URL('./fakes.js', import.meta.url).href;
    const scriptEnv = { ...env, NODE_OPTIONS: `--import=${fakesUrl}` };
    for (const s of SETUP_SCRIPTS) {
      debug('running', s);
      runScript(s, scriptEnv, root);
    }
    if (seedTestingData) runScript('seed-testing.js', scriptEnv, root);

    const logs = [];
    server = spawn(process.execPath, ['--import', fakesUrl, path.join(BACKEND, 'src', 'index.js')], {
      env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', d => logs.push(d.toString()));
    server.stderr.on('data', d => logs.push(d.toString()));

    const baseUrl = `http://127.0.0.1:${apiPort}`;
    const deadline = Date.now() + 60000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`API exited during startup:\n${logs.join('')}`);
      try {
        const r = await fetch(`${baseUrl}/health`);
        if (r.ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`API did not start:\n${logs.join('')}`);
      await new Promise(r => setTimeout(r, 250));
    }

    return {
      baseUrl,
      databaseUrl: env.DATABASE_URL,
      logs,
      /** Run one of src/db/*.js against the test DB; returns { ok, output }. */
      runDbScript(script) {
        try {
          return { ok: true, output: execFileSync(process.execPath, [path.join(BACKEND, 'src', 'db', script)], { env: scriptEnv, cwd: root, encoding: 'utf8', timeout: 120000 }) };
        } catch (err) {
          return { ok: false, output: `${err.stdout || ''}${err.stderr || ''}` };
        }
      },
      setAiResponse(text) {
        fs.writeFileSync(aiFile, JSON.stringify({ text: typeof text === 'string' ? text : JSON.stringify(text) }));
      },
      fakeCalls(service) {
        return fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
          .filter(c => !service || c.service === service);
      },
      clearFakeCalls() { fs.writeFileSync(fakeLog, ''); },
      /** The next n WhatsApp sends fail with HTTP 500 (0 = stop failing). */
      setWaFailures(n) { fs.writeFileSync(waFailFile, String(n)); },
      waFailuresLeft() { return parseInt(fs.readFileSync(waFailFile, 'utf8'), 10) || 0; },
      /**
       * Wait until the job queue has no pending/running job that is due
       * (run_at <= now). Call after an API action whose side effects run on the
       * worker, before asserting on fakeCalls(). Throws on timeout.
       * all: true also waits for jobs scheduled later (retries with backoff,
       * staggered broadcast sends).
       */
      async waitForJobs({ timeoutMs = 15000, timeout, all = false } = {}) {
        const limit = timeout ?? timeoutMs;
        const c = new pgLib.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await c.connect();
        try {
          const deadline = Date.now() + limit;
          for (;;) {
            const { rows } = await c.query(
              `SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('pending', 'running')${all ? '' : ' AND run_at <= now()'}`);
            if (rows[0].n === 0) return;
            if (Date.now() > deadline) throw new Error(`waitForJobs: ${rows[0].n} job(s) still pending after ${limit}ms`);
            await new Promise(r => setTimeout(r, 25));
          }
        } finally {
          await c.end();
        }
      },
      stop: teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}
