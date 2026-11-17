/**
 * Black-box tests: authentication, authorisation (RBAC) and HTTP security.
 *
 * All behaviour is exercised over HTTP against a throwaway server. The DB is
 * touched directly only to set up states that have no API (deactivating a
 * staff member, changing a role) and never to assert.
 *
 * Request budget: /api is rate-limited to 200 req / 15 min per IP. This file
 * sends ~130 /api requests (the route table is the bulk of it).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { startTestEnv, ADMIN, JWT_SECRET, VERIFY_TOKEN, BACKEND } from '../helpers/env.js';

let env;
let adminToken;
const users = {}; // role -> { id, email, password, token }

// ── tiny HTTP helpers ────────────────────────────────────────────────────────
async function call(method, p, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
  const res = await fetch(`${env.baseUrl}${p}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

const uniq = () => crypto.randomBytes(5).toString('hex');

async function login(email, password) {
  return call('POST', '/api/staff/login', { body: { email, password } });
}

async function withDb(fn) {
  const client = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function createStaff(role, token = adminToken) {
  const email = `${role}.${uniq()}@test.local`;
  const password = `Pw-${uniq()}-long`;
  const r = await call('POST', '/api/staff', { token, body: { name: `T ${role}`, email, password, role } });
  assert.equal(r.status, 201, r.text);
  const l = await login(email, password);
  assert.equal(l.status, 200, l.text);
  return { id: r.json.staff.id, email, password, token: l.json.token };
}

function assertNoLeak(r) {
  // No stack traces, file paths, or driver internals in any error body.
  assert.doesNotMatch(r.text, /\bat .+\(.*:\d+:\d+\)|node_modules|[A-Z]:\\|\/src\/|SyntaxError|PayloadTooLarge|invalid input syntax|stack/i,
    `response leaks internals: ${r.text.slice(0, 300)}`);
}

// ── Route table, enumerated from the source (white-box) ─────────────────────
// Routers are mounted in src/app.js (createApp); route files live in
// src/modules/<domain>/routes.js (src/routes/*.js is read too if it ever returns).
function routeFiles() {
  const files = [];
  const legacy = path.join(BACKEND, 'src', 'routes');
  if (fs.existsSync(legacy)) files.push(...fs.readdirSync(legacy).filter(f => f.endsWith('.js')).map(f => path.join(legacy, f)));
  const modules = path.join(BACKEND, 'src', 'modules');
  if (fs.existsSync(modules)) {
    for (const d of fs.readdirSync(modules)) {
      const f = path.join(modules, d, 'routes.js');
      if (fs.existsSync(f)) files.push(f);
    }
  }
  return files;
}

function enumerateMountedRoutes() {
  const index = fs.readFileSync(path.join(BACKEND, 'src', 'app.js'), 'utf8');
  const mounts = {};
  for (const m of index.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) mounts[m[2]] = m[1];
  const routes = [];
  for (const file of routeFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(\w+)\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
      const base = mounts[m[1]];
      if (!base) continue; // router not mounted
      const full = (base + (m[3] === '/' ? '' : m[3])) || '/';
      routes.push({ method: m[2].toUpperCase(), path: full });
    }
  }
  return routes;
}

const PUBLIC = new Set([
  'POST /api/staff/login',
  'GET /webhook',
  'POST /webhook',
]);

before(async () => {
  env = await startTestEnv();
  const r = await login(ADMIN.email, ADMIN.password);
  assert.equal(r.status, 200, r.text);
  adminToken = r.json.token;
  users.consultant = await createStaff('consultant');
  users.manager = await createStaff('manager');
}, { timeout: 240000 });

after(async () => { await env?.stop(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('login', () => {
  test('correct credentials return a token and safe staff profile', async () => {
    const r = await login(ADMIN.email, ADMIN.password);
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.token, 'string');
    assert.equal(r.json.staff.email, ADMIN.email);
    assert.equal(r.json.staff.role, 'admin');
    assert.equal(r.json.staff.password_hash, undefined);
    const decoded = jwt.verify(r.json.token, JWT_SECRET);
    assert.equal(decoded.role, 'admin');
    assert.ok(decoded.exp > decoded.iat, 'token must expire');
    assert.equal(decoded.password_hash, undefined);
  });

  test('wrong password -> 401 generic message', async () => {
    const r = await login(ADMIN.email, 'WrongPass999!');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Invalid credentials');
    assert.equal(r.json.token, undefined);
  });

  test('unknown email -> 401 with the same message (no user enumeration)', async () => {
    const r = await login(`nobody.${uniq()}@test.local`, 'WhateverPass1');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Invalid credentials');
  });

  test('email is case-insensitive', async () => {
    const r = await login(ADMIN.email.toUpperCase(), ADMIN.password);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.staff.email, ADMIN.email);
  });

  test('password is case-sensitive', async () => {
    const r = await login(ADMIN.email, ADMIN.password.toLowerCase());
    assert.equal(r.status, 401);
  });

  test('missing fields -> 400', async () => {
    for (const body of [{}, { email: ADMIN.email }, { password: ADMIN.password }, { email: '', password: '' }]) {
      const r = await login(body.email, body.password);
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(r.json.token, undefined);
    }
  });

  test('non-string / type-confused fields -> 400 (never 500 or 200)', async () => {
    for (const body of [
      { email: [ADMIN.email], password: ADMIN.password },
      { email: { $ne: null }, password: { $ne: null } },
      { email: ADMIN.email, password: 123456789 },
    ]) {
      const r = await call('POST', '/api/staff/login', { body });
      assert.equal(r.status, 400, `body ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    }
    const arr = await call('POST', '/api/staff/login', { body: [] });
    assert.equal(arr.status, 400);
  });

  test('SQL-injection strings in email never authenticate or 500', async () => {
    const payloads = [
      "' OR '1'='1",
      "admin@test.local' --",
      "' OR 1=1; DROP TABLE staff; --@x.com",
      "\"' OR ''='\"@test.local",
      "a@b.c' UNION SELECT * FROM staff --",
    ];
    for (const email of payloads) {
      const r = await login(email, "' OR '1'='1");
      assert.ok([400, 401].includes(r.status), `${email} -> ${r.status} ${r.text}`);
      assert.equal(r.json?.token, undefined);
    }
    // the table is still there and the admin can still log in
    const ok = await login(ADMIN.email, ADMIN.password);
    assert.equal(ok.status, 200);
  });

  test('malformed JSON body -> 400 (not 500)', async () => {
    const r = await call('POST', '/api/staff/login', {
      raw: '{"email": "admin@test.local", "password": ', headers: { 'Content-Type': 'application/json' },
    });
    assertNoLeak(r);
    assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
  });

  test('body over 1mb -> 413 (not 500)', async () => {
    const big = JSON.stringify({ email: ADMIN.email, password: 'x'.repeat(1.2 * 1024 * 1024) });
    const r = await call('POST', '/api/staff/login', { raw: big, headers: { 'Content-Type': 'application/json' } });
    assertNoLeak(r);
    assert.equal(r.status, 413, `got ${r.status} ${r.text}`);
  });

  test('non-JSON content type is treated as missing body -> 400', async () => {
    const r = await call('POST', '/api/staff/login', {
      raw: `email=${ADMIN.email}&password=${ADMIN.password}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(r.status, 400, r.text);
  });

  test('deactivated staff cannot log in', async () => {
    const u = await createStaff('consultant');
    await withDb(c => c.query('UPDATE staff SET is_active = false WHERE id = $1', [u.id]));
    const r = await login(u.email, u.password);
    assert.equal(r.status, 401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('JWT handling on /api/staff/me', () => {
  const me = token => call('GET', '/api/staff/me', { token });

  test('valid token -> 200 with own profile, no password hash', async () => {
    const r = await me(adminToken);
    assert.equal(r.status, 200);
    assert.equal(r.json.staff.email, ADMIN.email);
    assert.equal(r.json.staff.password_hash, undefined);
  });

  test('missing Authorization header -> 401', async () => {
    const r = await me();
    assert.equal(r.status, 401);
  });

  test('wrong scheme / malformed header values -> 401', async () => {
    for (const header of [adminToken, `Basic ${adminToken}`, 'Bearer', 'Bearer ', 'Bearer not.a.jwt', `Bearer ${adminToken}x`, 'Bearer ' + 'a'.repeat(5000)]) {
      const r = await call('GET', '/api/staff/me', { headers: { Authorization: header } });
      assert.equal(r.status, 401, `header "${header.slice(0, 30)}" -> ${r.status}`);
      assertNoLeak(r);
    }
  });

  test('expired token -> 401', async () => {
    const { id } = jwt.decode(adminToken);
    const t = jwt.sign({ id, email: ADMIN.email, role: 'admin', name: 'x', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, JWT_SECRET);
    const r = await me(t);
    assert.equal(r.status, 401);
  });

  test('token signed with a different secret -> 401', async () => {
    const { id } = jwt.decode(adminToken);
    const t = jwt.sign({ id, email: ADMIN.email, role: 'admin', name: 'x' }, 'not_the_secret', { expiresIn: '1h' });
    assert.equal((await me(t)).status, 401);
    // and the well-known config fallback secret is not accepted either
    const t2 = jwt.sign({ id, email: ADMIN.email, role: 'admin', name: 'x' }, 'dev_secret_change_in_production', { expiresIn: '1h' });
    assert.equal((await me(t2)).status, 401);
  });

  test('alg:none token -> 401', async () => {
    const { id } = jwt.decode(adminToken);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id, email: ADMIN.email, role: 'admin', exp })}.`;
    assert.equal((await me(t)).status, 401);
  });

  test('tampered payload (consultant -> admin) with original signature -> 401', async () => {
    const [h, p, s] = users.consultant.token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.role = 'admin';
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    assert.equal((await me(forged)).status, 401);
    const s2 = await call('GET', '/api/settings', { token: forged });
    assert.equal(s2.status, 401);
  });

  test('validly-signed token for a non-existent staff id -> 404, no 500', async () => {
    const t = jwt.sign({ id: crypto.randomUUID(), email: 'ghost@test.local', role: 'consultant', name: 'g' }, JWT_SECRET, { expiresIn: '1h' });
    const r = await me(t);
    assert.ok([401, 404].includes(r.status), `got ${r.status}`);
  });

  test('token of a deactivated staff member is still accepted', async () => {
    const u = await createStaff('consultant');
    await withDb(c => c.query('UPDATE staff SET is_active = false WHERE id = $1', [u.id]));
    const r = await call('GET', '/api/clients', { token: u.token });
    assert.equal(r.status, 401, `deactivated user's token -> ${r.status} on GET /api/clients`);
  });

  test('token of a deleted staff member is still accepted', async () => {
    const u = await createStaff('consultant');
    const d = await call('DELETE', `/api/staff/${u.id}`, { token: adminToken });
    assert.equal(d.status, 204, d.text);
    const r = await call('GET', '/api/orders/kpis', { token: u.token });
    assert.equal(r.status, 401, `deleted user's token -> ${r.status} on GET /api/orders/kpis`);
  });

  test('role downgrade is not enforced until the token expires', async () => {
    const u = await createStaff('manager');
    await withDb(c => c.query(`UPDATE staff SET role = 'consultant' WHERE id = $1`, [u.id]));
    const r = await call('GET', '/api/settings', { token: u.token });
    assert.equal(r.status, 403, `demoted manager still reads settings -> ${r.status}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('every mounted route requires authentication unless public', () => {
  const routes = enumerateMountedRoutes();

  test('route enumeration found the expected surface', () => {
    assert.ok(routes.length >= 50, `only ${routes.length} routes found`);
    for (const r of PUBLIC) assert.ok(routes.some(x => `${x.method} ${x.path}` === r), `missing ${r}`);
  });

  test('unauthenticated requests -> 401 on all non-public /api routes', async () => {
    const failures = [];
    let checked = 0;
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (PUBLIC.has(key)) continue;
      const url = r.path.replace(/:id\b/g, crypto.randomUUID()).replace(/:key\b/g, 'busy_mode');
      const res = await call(r.method, url, ['POST', 'PATCH', 'PUT'].includes(r.method) ? { body: {} } : {});
      checked++;
      if (res.status !== 401) failures.push(`${key} -> ${res.status}`);
    }
    assert.ok(checked >= 50);
    assert.deepEqual(failures, []);
  });

  test('unauthenticated mutation does not take effect (settings unchanged)', async () => {
    await call('PATCH', '/api/settings/busy_mode', { body: { value: 'true' } });
    const r = await call('GET', '/api/settings', { token: adminToken });
    assert.equal(r.json.settings.busy_mode, 'false');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('role-based access control', () => {
  test('settings: consultant 403; manager and admin 200', async () => {
    assert.equal((await call('GET', '/api/settings', { token: users.consultant.token })).status, 403);
    assert.equal((await call('GET', '/api/settings', { token: users.manager.token })).status, 200);
    assert.equal((await call('GET', '/api/settings', { token: adminToken })).status, 200);
  });

  test('PATCH settings: consultant 403 and value unchanged; manager allowed', async () => {
    const c = await call('PATCH', '/api/settings/busy_mode', { token: users.consultant.token, body: { value: 'true' } });
    assert.equal(c.status, 403);
    const m = await call('PATCH', '/api/settings/busy_mode', { token: users.manager.token, body: { value: 'false' } });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.setting.value, 'false');
  });

  test('products create/update: consultant 403; manager passes the role gate', async () => {
    const id = crypto.randomUUID();
    assert.equal((await call('POST', '/api/products', { token: users.consultant.token, body: {} })).status, 403);
    assert.equal((await call('PATCH', `/api/products/${id}`, { token: users.consultant.token, body: {} })).status, 403);
    const m = await call('POST', '/api/products', { token: users.manager.token, body: {} });
    assert.notEqual(m.status, 403);
    assert.notEqual(m.status, 401);
  });

  test('consultant cannot create staff (including an admin) or delete staff', async () => {
    const email = `esc.${uniq()}@test.local`;
    const r = await call('POST', '/api/staff', {
      token: users.consultant.token, body: { name: 'Evil', email, password: 'EvilPass123', role: 'admin' },
    });
    assert.equal(r.status, 403);
    assert.equal((await login(email, 'EvilPass123')).status, 401, 'escalated account must not exist');
    const d = await call('DELETE', `/api/staff/${users.manager.id}`, { token: users.consultant.token });
    assert.equal(d.status, 403);
  });

  test('manager cannot create staff or delete staff (admin only)', async () => {
    const r = await call('POST', '/api/staff', {
      token: users.manager.token, body: { name: 'M', email: `m.${uniq()}@test.local`, password: 'MgrPass1234', role: 'admin' },
    });
    assert.equal(r.status, 403);
    const d = await call('DELETE', `/api/staff/${users.consultant.id}`, { token: users.manager.token });
    assert.equal(d.status, 403);
  });

  test('there is no self-service endpoint to change own role', async () => {
    for (const [m, p] of [['PATCH', '/api/staff/me'], ['PUT', '/api/staff/me'], ['PATCH', `/api/staff/${users.consultant.id}`]]) {
      const r = await call(m, p, { token: users.consultant.token, body: { role: 'admin' } });
      assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
    const me = await call('GET', '/api/staff/me', { token: users.consultant.token });
    assert.equal(me.json.staff.role, 'consultant');
  });

  test('admin create staff: validation, role enum, duplicate, email normalised', async () => {
    const bad = await call('POST', '/api/staff', { token: adminToken, body: { name: 'x', email: `r.${uniq()}@test.local`, password: 'Password123', role: 'superadmin' } });
    assert.equal(bad.status, 400);
    const short = await call('POST', '/api/staff', { token: adminToken, body: { name: 'x', email: `s.${uniq()}@test.local`, password: 'short' } });
    assert.equal(short.status, 400);
    const email = `Mixed.${uniq()}@Test.Local`;
    const ok = await call('POST', '/api/staff', { token: adminToken, body: { name: 'Def', email, password: 'Password123' } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.staff.role, 'consultant', 'default role is consultant');
    assert.equal(ok.json.staff.email, email.toLowerCase());
    assert.equal(ok.json.staff.password_hash, undefined);
    const dup = await call('POST', '/api/staff', { token: adminToken, body: { name: 'Dup', email: email.toUpperCase(), password: 'Password123' } });
    assert.equal(dup.status, 409);
  });

  test('staff list never leaks password_hash', async () => {
    const r = await call('GET', '/api/staff', { token: users.consultant.token });
    assert.equal(r.status, 200);
    assert.ok(r.json.staff.length >= 3);
    assert.doesNotMatch(r.text, /password|\$2[aby]\$/);
  });

  test('DELETE unknown staff id -> 404', async () => {
    const r = await call('DELETE', `/api/staff/${crypto.randomUUID()}`, { token: adminToken });
    assert.equal(r.status, 404);
  });

  test('DELETE /api/staff/<non-uuid> -> 400/404 (not 500)', async () => {
    const r = await call('DELETE', '/api/staff/not-a-uuid', { token: adminToken });
    assertNoLeak(r);
    assert.ok([400, 404].includes(r.status), `got ${r.status} ${r.text}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('webhook', () => {
  test('GET verify with right token & mode echoes the challenge', async () => {
    const r = await fetch(`${env.baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '12345');
  });

  test('GET verify with wrong token / wrong mode / missing params -> 403', async () => {
    for (const qs of [
      `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,
      `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      `hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      ``,
      `hub.mode=subscribe&hub.verify_token[]=${VERIFY_TOKEN}&hub.challenge=1`,
    ]) {
      const r = await fetch(`${env.baseUrl}/webhook?${qs}`);
      assert.equal(r.status, 403, `?${qs} -> ${r.status}`);
      assert.doesNotMatch(await r.text(), /^1$/);
    }
  });

  test('POST junk / non-WhatsApp bodies -> 200 and server stays healthy', async () => {
    const junk = [
      {},
      [],
      { object: 'page', entry: [{}] },
      { object: 'whatsapp_business_account' },
      { object: 'whatsapp_business_account', entry: 'notarray' },
      { object: 'whatsapp_business_account', entry: 5 },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: null }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ type: 'text' }] } }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ type: 'image', from: '27710000000' }], statuses: [{}] } }] }] },
    ];
    // Meta signs every POST: X-Hub-Signature-256 = HMAC-SHA256(raw body, META_APP_SECRET='fake')
    const sig = (raw) => `sha256=${crypto.createHmac('sha256', 'fake').update(raw).digest('hex')}`;
    for (const body of junk) {
      const raw = JSON.stringify(body);
      const r = await fetch(`${env.baseUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig(raw) }, body: raw });
      assert.equal(r.status, 200, `${JSON.stringify(body)} -> ${r.status}`);
    }
    const txt = await fetch(`${env.baseUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': sig('hello') }, body: 'hello' });
    assert.equal(txt.status, 200);
    await new Promise(r => setTimeout(r, 300));
    const h = await fetch(`${env.baseUrl}/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).status, 'ok');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('HTTP hygiene', () => {
  test('unknown routes -> 404 JSON', async () => {
    for (const p of ['/nope', '/api/nope', '/api/staff/does/not/exist']) {
      const r = await call('GET', p, { token: adminToken });
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
      assert.equal(r.json.error, 'Route not found');
    }
  });

  test('helmet security headers present, x-powered-by absent', async () => {
    const r = await fetch(`${env.baseUrl}/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('content-security-policy'));
    assert.ok(r.headers.get('strict-transport-security'));
    assert.ok(r.headers.get('x-frame-options'));
    assert.ok(r.headers.get('referrer-policy'));
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('CORS: allowed dev origin gets ACAO + credentials', async () => {
    const r = await fetch(`${env.baseUrl}/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    const pre = await fetch(`${env.baseUrl}/api/staff/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
    assert.ok(pre.status === 204 || pre.status === 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('CORS: disallowed origin gets no ACAO header (simple + preflight)', async () => {
    const evil = 'https://evil.example.com';
    const r = await fetch(`${env.baseUrl}/health`, { headers: { Origin: evil } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${env.baseUrl}/api/staff/login`, {
      method: 'OPTIONS', headers: { Origin: evil, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    for (const o of ['http://localhost:5173.evil.com', 'null', 'http://LOCALHOST:5173x']) {
      const x = await fetch(`${env.baseUrl}/health`, { headers: { Origin: o } });
      assert.equal(x.headers.get('access-control-allow-origin'), null, o);
    }
  });

  test('rate limiter headers are present on /api', async () => {
    const r = await call('GET', '/api/staff/me', { token: adminToken });
    assert.ok(r.headers.get('ratelimit-limit') || r.headers.get('x-ratelimit-limit'), 'no rate-limit header');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('quotation PDF endpoint (staff only — AUTH-4)', () => {
  test('without auth -> 401 (no PDF, no hint whether the quote exists)', async () => {
    const r = await call('GET', `/api/quotations/${crypto.randomUUID()}/pdf`);
    assert.equal(r.status, 401);
    assertNoLeak(r);
  });

  test('non-UUID id -> 400/404 (not 500)', async () => {
    for (const id of ['not-a-uuid', "1' OR '1'='1"]) {
      const r = await call('GET', `/api/quotations/${encodeURIComponent(id)}/pdf`);
      assertNoLeak(r);
      assert.ok([400, 401, 404].includes(r.status), `${id} -> ${r.status} ${r.text}`); // 401: auth runs first (AUTH-4)
    }
  });

  test('the PDF route does not open the rest of the quotations API', async () => {
    const id = crypto.randomUUID();
    for (const p of [`/api/quotations/${id}`, `/api/quotations/${id}/pdf/../`, '/api/quotations/']) {
      const r = await call('GET', p);
      assert.equal(r.status, 401, `${p} -> ${r.status}`);
    }
  });
});
