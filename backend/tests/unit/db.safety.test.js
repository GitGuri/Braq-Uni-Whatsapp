// db/safety.js and the seed refusal rules (SEC-1) — pure, no database.
import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

let safety, seed;
before(async () => {
  safety = await import(src('db/safety.js'));
  seed = await import(src('db/seed.js'));
});

const SUPABASE = 'postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
const LOCAL = 'postgresql://postgres:pw@127.0.0.1:5432/braquni';

describe('productionReason', () => {
  test('NODE_ENV=production is production', () => {
    assert.match(safety.productionReason({ env: 'production', url: LOCAL }), /NODE_ENV is production/);
  });
  test('a Supabase URL is production, whatever NODE_ENV says', () => {
    assert.match(safety.productionReason({ env: 'development', url: SUPABASE }), /Supabase/);
    assert.match(safety.productionReason({ env: 'test', url: 'postgresql://u:p@db.xyz.supabase.co:5432/postgres' }), /Supabase/);
  });
  test('a local database in development / test is not production', () => {
    assert.equal(safety.productionReason({ env: 'development', url: LOCAL }), null);
    assert.equal(safety.productionReason({ env: 'test', url: LOCAL }), null);
    assert.equal(safety.productionReason({ env: 'development', host: 'localhost' }), null);
  });
  test('dbHost parses URLs and falls back to host', () => {
    assert.equal(safety.dbHost({ url: LOCAL }), '127.0.0.1');
    assert.equal(safety.dbHost({ host: 'db.local' }), 'db.local');
    assert.equal(safety.dbHost({ url: 'not a url' }), '');
  });
});

describe('seedRefusal (seed.js)', () => {
  const prod = { env: 'production', url: LOCAL };
  const supa = { env: 'development', url: SUPABASE };
  const local = { env: 'development', url: LOCAL };

  test('local: the default password is allowed', () => {
    assert.equal(seed.seedRefusal({ target: local, password: '' }), null);
  });
  test('production: no password → refused', () => {
    assert.match(seed.seedRefusal({ target: prod, password: '' }), /SEED_ADMIN_PASSWORD/);
    assert.match(seed.seedRefusal({ target: supa, password: '' }), /SEED_ADMIN_PASSWORD/);
  });
  test('production: the default or a short password → refused', () => {
    assert.ok(seed.seedRefusal({ target: prod, password: seed.DEFAULT_PASSWORD }));
    assert.ok(seed.seedRefusal({ target: supa, password: 'short' }));
  });
  test('production: a long, non-default password is allowed', () => {
    assert.equal(seed.seedRefusal({ target: prod, password: 'a-long-unique-passphrase' }), null);
  });
});
