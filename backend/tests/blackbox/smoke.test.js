import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, ADMIN } from '../helpers/env.js';

let env;
before(async () => { env = await startTestEnv(); });
after(async () => { await env?.stop(); });

test('health endpoint responds', async () => {
  const r = await fetch(`${env.baseUrl}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('seeded admin can log in', async () => {
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok((await r.json()).token);
});
