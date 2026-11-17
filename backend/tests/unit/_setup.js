// Shared unit-test bootstrap. Import this FIRST in every unit test file, then
// load app modules with `await import(src('...'))`.
//
// - Points every env var at safe dummy values (never the real backend/.env).
// - chdirs into this folder so core/config.js's dotenv.config() finds no .env.
// - Blocks all real network access via nock.
import nock from 'nock';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '0',
  API_BASE_URL: 'http://127.0.0.1:1',
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  META_APP_ID: 'fake',
  META_APP_SECRET: 'fake',
  META_PHONE_NUMBER_ID: '111222333',
  META_WHATSAPP_TOKEN: 'fake',
  META_WEBHOOK_VERIFY_TOKEN: 'fake_verify',
  META_API_VERSION: 'v20.0',
  JWT_SECRET: 'test',
  JWT_EXPIRES_IN: '1h',
  GEMINI_API_KEY: 'fake',
  RESEND_API_KEY: 're_fake',
  FROM_EMAIL: 'notifications@test.local',
  NOTIFICATION_OVERRIDE_EMAIL: '',
  DASHBOARD_BASE_URL: 'http://dash.test',
  LOG_LEVEL: 'error',
});

nock.disableNetConnect();

export { nock };

const SRC = new URL('../../src/', import.meta.url);
/** Absolute file URL of a module under backend/src. */
export const src = (p) => new URL(p, SRC).href;

/**
 * Programmable fake for src/core/db.js. Register handlers with `on(regex, result)`;
 * the first matching handler wins. `result` may be a value or (text, params) => value.
 * Every call is recorded in `calls`.
 */
export function makeFakeDb() {
  const calls = [];
  let handlers = [];
  const db = {
    calls,
    txLog: [],
    on(re, result, { once = false } = {}) { handlers.push({ re, result, once }); return db; },
    reset() { calls.length = 0; handlers = []; db.txLog.length = 0; },
    find(re) { return calls.filter((c) => re.test(c.text)); },
    async query(text, params) {
      calls.push({ text, params });
      for (const h of handlers) {
        if (h.re.test(text)) {
          if (h.once) handlers = handlers.filter((x) => x !== h);
          const r = typeof h.result === 'function' ? await h.result(text, params) : h.result;
          return r ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    async withTransaction(fn) {
      db.txLog.push('BEGIN');
      try {
        const r = await fn({ query: db.query });
        db.txLog.push('COMMIT');
        return r;
      } catch (e) {
        db.txLog.push('ROLLBACK');
        throw e;
      }
    },
  };
  return db;
}

/**
 * Replace the database module with a fake db (must run before the module under
 * test is imported). Mocks core/db.js.
 */
export function mockPool(db) {
  const namedExports = {
    query: (...a) => db.query(...a),
    withTransaction: (...a) => db.withTransaction(...a),
    pool: { query: (...a) => db.query(...a), on() {}, connect: async () => ({ query: db.query, release() {} }) },
    testConnection: async () => {},
    connectDirect: async () => { throw new Error('connectDirect is not available in unit tests'); },
    hasDirectUrl: () => false,
  };
  return mock.module(src('core/db.js'), { namedExports });
}

/** Strings that must never leak into user-facing text. */
export const BAD_TOKENS = ['undefined', 'null', 'NaN', '[object Object]'];
export function assertClean(assert, text, label = '') {
  assert.equal(typeof text, 'string', `${label}: expected string output`);
  for (const bad of BAD_TOKENS) {
    assert.ok(!text.includes(bad), `${label}: output contains "${bad}":\n${text}`);
  }
}
