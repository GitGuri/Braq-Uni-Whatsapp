// Production start-up check (SEC-2, AUTH-3) and the webhook's no-secret rule — pure.
import './_setup.js';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { src } from './_setup.js';

let cfg, webhook;
before(async () => {
  cfg = await import(src('core/config.js'));
  webhook = await import(src('modules/webhook/controller.js'));
});

const GOOD = Object.freeze({
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/postgres',
  META_APP_SECRET: 'a1b2c3d4e5f6',
  META_WHATSAPP_TOKEN: 'EAAG-real-token',
  META_PHONE_NUMBER_ID: '123456',
  META_WEBHOOK_VERIFY_TOKEN: 'f3a9c1-random-verify',
  GEMINI_API_KEY: 'AIza-real',
  RESEND_API_KEY: 're_real',
  API_BASE_URL: 'https://api.braquni.co.za',
  DASHBOARD_BASE_URL: 'https://dash.braquni.co.za',
  JWT_SECRET: 'k'.repeat(48),
});

describe('productionConfigProblems', () => {
  test('a complete configuration passes', () => {
    assert.deepEqual(cfg.productionConfigProblems({ ...GOOD }), []);
  });

  test('a missing META_APP_SECRET is refused (webhook signatures)', () => {
    const p = cfg.productionConfigProblems({ ...GOOD, META_APP_SECRET: '' });
    assert.equal(p.length, 1);
    assert.match(p[0], /META_APP_SECRET/);
  });

  test('every required variable is reported, not just the first', () => {
    const p = cfg.productionConfigProblems({});
    for (const k of ['DATABASE_URL', 'META_APP_SECRET', 'META_WHATSAPP_TOKEN', 'META_PHONE_NUMBER_ID',
      'META_WEBHOOK_VERIFY_TOKEN', 'GEMINI_API_KEY', 'RESEND_API_KEY', 'JWT_SECRET']) {
      assert.ok(p.some((m) => m.startsWith(k)), `${k} should be reported`);
    }
  });

  test('JWT_SECRET: dev default, .env.example placeholder and short secrets are refused', () => {
    for (const bad of ['dev_secret_change_in_production', 'your_super_secret_jwt_key_min_32_chars', 'short']) {
      const p = cfg.productionConfigProblems({ ...GOOD, JWT_SECRET: bad });
      assert.ok(p.some((m) => m.includes('JWT_SECRET')), `${bad} should be refused`);
    }
  });

  test('placeholders and the default verify token are refused', () => {
    assert.ok(cfg.productionConfigProblems({ ...GOOD, META_APP_SECRET: 'your_meta_app_secret' }).length);
    assert.ok(cfg.productionConfigProblems({ ...GOOD, RESEND_API_KEY: 're_your_resend_api_key' }).length);
    assert.ok(cfg.productionConfigProblems({ ...GOOD, META_WEBHOOK_VERIFY_TOKEN: 'braquni_verify' }).length);
  });

  test('SEC-3 database TLS without certificate verification is refused in production', () => {
    assert.ok(cfg.productionConfigProblems({ ...GOOD, DB_SSL_MODE: 'no-verify' }).some((m) => m.includes('DB_SSL_MODE')));
    assert.ok(cfg.productionConfigProblems({ ...GOOD, DB_SSL_MODE: 'disable' }).length);
    assert.deepEqual(cfg.productionConfigProblems({ ...GOOD, DB_SSL_MODE: 'verify' }), []);
  });

  test('WHATSAPP_WINDOW_CHECK=off is refused in production', () => {
    assert.ok(cfg.productionConfigProblems({ ...GOOD, WHATSAPP_WINDOW_CHECK: 'off' }).length);
  });

  test('assertProductionConfig only applies in production', () => {
    assert.doesNotThrow(() => cfg.assertProductionConfig({}, 'development'));
    assert.doesNotThrow(() => cfg.assertProductionConfig({}, 'test'));
    assert.throws(() => cfg.assertProductionConfig({}, 'production'), /Unsafe production configuration/);
    assert.doesNotThrow(() => cfg.assertProductionConfig({ ...GOOD }, 'production'));
  });
});

describe('webhook hasValidSignature', () => {
  const saved = {};
  before(() => { saved.env = cfg.config.env; saved.secret = cfg.config.meta.appSecret; });
  after(() => { cfg.config.env = saved.env; cfg.config.meta.appSecret = saved.secret; });

  const req = (body, sig) => ({ rawBody: Buffer.from(body), body: JSON.parse(body), get: () => sig });

  test('production without a secret rejects every request (never "allow and warn")', () => {
    cfg.config.env = 'production';
    cfg.config.meta.appSecret = '';
    assert.equal(webhook.hasValidSignature(req('{"a":1}', undefined)), false);
    assert.equal(webhook.hasValidSignature(req('{"a":1}', 'sha256=00')), false);
  });

  test('with a secret: only the correct HMAC of the raw body passes', () => {
    cfg.config.env = 'production';
    cfg.config.meta.appSecret = 'shh';
    const body = '{"object":"whatsapp_business_account"}';
    const sig = `sha256=${crypto.createHmac('sha256', 'shh').update(body).digest('hex')}`;
    assert.equal(webhook.hasValidSignature(req(body, sig)), true);
    assert.equal(webhook.hasValidSignature(req(body, 'sha256=' + '0'.repeat(64))), false);
    assert.equal(webhook.hasValidSignature(req(body, undefined)), false);
  });

  test('development without a secret still allows (local testing with ngrok)', () => {
    cfg.config.env = 'development';
    cfg.config.meta.appSecret = '';
    assert.equal(webhook.hasValidSignature(req('{}', undefined)), true);
  });
});
