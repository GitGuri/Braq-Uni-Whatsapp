// requireAuth's per-request account check, role-based route guards and the
// RBAC permission map — through the real app (createApp + supertest) and a real
// staff table.
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const auth = await t.load('middleware/auth.js');
const { createApp } = await t.load('app.js');
const request = (await import('supertest')).default;

let app;
before(() => { app = createApp(); });
beforeEach(() => t.reset());
after(() => t.stop());

const bearer = (staff) => `Bearer ${auth.generateToken(staff)}`;

async function runAuth(headers) {
  const req = { headers };
  const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextCalled = 0;
  await auth.requireAuth(req, res, () => { nextCalled++; });
  return { req, res, nextCalled };
}

describe('requireAuth (account re-checked on every request)', () => {
  test('valid token for an active account → next() with req.staff from the database', async () => {
    const staff = await t.factory.staff({ name: 'Ann', role: 'consultant' });
    const { req, res, nextCalled } = await runAuth({ authorization: bearer(staff) });
    assert.equal(nextCalled, 1);
    assert.equal(res.body, undefined);
    assert.deepEqual([req.staff.id, req.staff.role, req.staff.name, req.staff.email], [staff.id, 'consultant', 'Ann', staff.email]);
    assert.equal(req.staff.password_hash, undefined, 'never exposes the hash');
  });

  test('token for a deactivated account → 401', async () => {
    const staff = await t.factory.staff({ is_active: false });
    const { res, nextCalled } = await runAuth({ authorization: bearer(staff) });
    assert.equal(res.statusCode, 401);
    assert.match(res.body.error, /inactive or removed/);
    assert.equal(nextCalled, 0);
  });

  test('token for a deleted account → 401', async () => {
    const staff = await t.factory.staff();
    const header = bearer(staff);
    await t.query('DELETE FROM staff WHERE id = $1', [staff.id]);
    const { res, nextCalled } = await runAuth({ authorization: header });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, 0);
  });

  test('role comes from the database, not the token', async () => {
    const staff = await t.factory.staff({ role: 'consultant' });
    const { req } = await runAuth({ authorization: bearer({ ...staff, role: 'admin' }) }); // stale/forged role claim
    assert.equal(req.staff.role, 'consultant');
  });

  test('a token whose id is not a uuid → 401 (no 500)', async () => {
    const { res } = await runAuth({ authorization: bearer({ id: 'not-a-uuid', email: 'x@y', role: 'admin', name: 'X' }) });
    assert.equal(res.statusCode, 401);
  });
});

describe('staff route guards', () => {
  test('POST /login is public (validation, not auth, rejects an empty body)', async () => {
    const r = await request(app).post('/api/staff/login').send({});
    assert.equal(r.status, 400);
  });

  test('GET /staff requires a token', async () => {
    assert.equal((await request(app).get('/api/staff')).status, 401);
  });

  for (const role of ['consultant', 'manager', 'admin']) {
    test(`GET /staff is allowed for ${role}`, async () => {
      const me = await t.factory.staff({ role });
      const r = await request(app).get('/api/staff').set('Authorization', bearer(me));
      assert.equal(r.status, 200);
      assert.ok(r.body.staff.some((s) => s.id === me.id));
      assert.ok(r.body.staff.every((s) => s.password_hash === undefined));
    });
  }

  for (const role of ['consultant', 'manager']) {
    test(`POST / and DELETE /:id are forbidden for ${role} (staff.manage)`, async () => {
      const me = await t.factory.staff({ role });
      const victim = await t.factory.staff();
      assert.equal((await request(app).post('/api/staff').set('Authorization', bearer(me)).send({ name: 'X', email: 'x@test.local', password: 'Password123', role: 'admin' })).status, 403);
      assert.equal((await request(app).delete(`/api/staff/${victim.id}`).set('Authorization', bearer(me))).status, 403);
      assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM staff WHERE id = $1', [victim.id])).n, 1);
    });
  }

  test('admin can create and delete staff; /me needs auth', async () => {
    const admin = await t.factory.staff({ role: 'admin' });
    const created = await request(app).post('/api/staff').set('Authorization', bearer(admin))
      .send({ name: 'New Person', email: 'NEW@test.local', password: 'Password123', role: 'consultant' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.staff.email, 'new@test.local');
    const del = await request(app).delete(`/api/staff/${created.body.staff.id}`).set('Authorization', bearer(admin));
    assert.equal(del.status, 204);
    assert.equal((await request(app).get('/api/staff/me')).status, 401);
    const me = await request(app).get('/api/staff/me').set('Authorization', bearer(admin));
    assert.equal(me.status, 200);
    assert.equal(me.body.staff.id, admin.id);
  });
});

describe('RBAC permission map on routes', () => {
  const as = async (role) => bearer(await t.factory.staff({ role }));

  for (const [method, path, body] of [
    ['post', '/api/broadcasts/delay', {}],
    ['post', '/api/broadcasts/busy', {}],
    ['post', '/api/broadcasts/custom', { message: 'hi' }],
    ['post', '/api/broadcasts/upload-attachment', {}],
    ['get', '/api/analytics/revenue'],
    ['get', '/api/analytics/top-clients'],
    ['get', '/api/analytics/top-products'],
    ['get', '/api/settings'],
    ['patch', '/api/settings/busy_mode', { value: 'true' }],
    ['post', '/api/products', {}],
    ['post', '/api/school-catalog', {}],
    ['post', '/api/purchase-orders', {}],
  ]) {
    test(`consultant → 403 on ${method.toUpperCase()} ${path}; manager passes the gate`, async () => {
      const consultant = await as('consultant');
      const r = await request(app)[method](path).set('Authorization', consultant).send(body ?? undefined);
      assert.equal(r.status, 403, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
      const manager = await as('manager');
      const m = await request(app)[method](path).set('Authorization', manager).send(body ?? undefined);
      assert.notEqual(m.status, 403, `${path}: manager got 403`);
      assert.notEqual(m.status, 401);
    });
  }

  test('a consultant broadcast attempt sends nothing and logs nothing', async () => {
    const client = await t.factory.client({ client_type: 'corporate' });
    await t.factory.order({ client_id: client.id, stage: 'in_production' });
    await request(app).post('/api/broadcasts/custom').set('Authorization', await as('consultant')).send({ message: 'spam' });
    assert.equal(t.wa.sent.length, 0);
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM broadcasts')).n, 0);
  });

  test('broadcast history stays readable by consultants', async () => {
    const r = await request(app).get('/api/broadcasts').set('Authorization', await as('consultant'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { broadcasts: [] });
  });
});
