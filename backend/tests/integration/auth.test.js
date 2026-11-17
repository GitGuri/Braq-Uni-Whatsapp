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

describe('AUTH-2 staff management: deactivate (never erase), last-admin and self guards, password', () => {
  const del = (id, as) => request(app).delete(`/api/staff/${id}`).set('Authorization', bearer(as));
  const patch = (id, as, body) => request(app).patch(`/api/staff/${id}`).set('Authorization', bearer(as)).send(body);
  const staffRow = (id) => t.one('SELECT role, is_active FROM staff WHERE id = $1', [id]);

  test('DELETE deactivates: the row and its history stay, the token stops working at once', async () => {
    const admin = await t.factory.staff({ role: 'admin' });
    const leaver = await t.factory.staff({ role: 'consultant' });
    assert.equal((await del(leaver.id, admin)).status, 204);
    assert.deepEqual(await staffRow(leaver.id), { role: 'consultant', is_active: false });
    assert.equal((await request(app).get('/api/staff/me').set('Authorization', bearer(leaver))).status, 401);
    const list = await request(app).get('/api/staff').set('Authorization', bearer(admin));
    assert.equal(list.body.staff.find((s) => s.id === leaver.id).is_active, false, 'listed as inactive');
  });

  test('an admin cannot remove or demote themselves', async () => {
    const admin = await t.factory.staff({ role: 'admin' });
    await t.factory.staff({ role: 'admin' });
    const r = await del(admin.id, admin);
    assert.deepEqual([r.status, r.body.code], [400, 'SELF']);
    assert.equal((await patch(admin.id, admin, { role: 'consultant' })).status, 400);
    assert.deepEqual(await staffRow(admin.id), { role: 'admin', is_active: true });
  });

  test('two admins removing each other at the same moment → one wins, the other gets 409 LAST_ADMIN; one admin remains', async () => {
    await t.query(`UPDATE staff SET is_active = false WHERE role = 'admin'`);
    const a = await t.factory.staff({ role: 'admin' });
    const b = await t.factory.staff({ role: 'admin' });
    const [ra, rb] = await Promise.all([del(b.id, a), del(a.id, b)]);
    const statuses = [ra.status, rb.status].sort();
    // The loser either sees LAST_ADMIN (lock order) or is already deactivated by the winner (401 on its token).
    assert.equal(statuses[0], 204);
    assert.ok([401, 409].includes(statuses[1]), `second request: ${statuses[1]}`);
    const { n } = await t.one(`SELECT COUNT(*)::int AS n FROM staff WHERE role = 'admin' AND is_active`);
    assert.equal(n, 1);
  });

  test('service guard: removing or demoting the only active admin → 409 LAST_ADMIN', async () => {
    const svc = await t.load('modules/staff/service.js');
    await t.query(`UPDATE staff SET is_active = false WHERE role = 'admin'`);
    const only = await t.factory.staff({ role: 'admin' });
    await assert.rejects(svc.remove(only.id, null), (e) => e.status === 409 && e.extra?.code === 'LAST_ADMIN');
    await assert.rejects(svc.update(only.id, null, { role: 'manager' }), (e) => e.extra?.code === 'LAST_ADMIN');
    assert.deepEqual(await staffRow(only.id), { role: 'admin', is_active: true });
  });

  test('PATCH: role change, reactivation and password reset; consultants cannot', async () => {
    const admin = await t.factory.staff({ role: 'admin' });
    const c = await t.factory.staff({ role: 'consultant' });
    assert.equal((await patch(c.id, c, { role: 'admin' })).status, 403);
    const up = await patch(c.id, admin, { role: 'manager' });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.staff.role, 'manager');
    assert.equal(up.body.staff.password_hash, undefined);
    assert.equal((await patch(c.id, admin, { password: 'short' })).status, 400);
    assert.equal((await patch(c.id, admin, { password: 'BrandNewPass123' })).status, 200);
    assert.equal((await patch(c.id, admin, { nonsense: 1 })).status, 400, 'unknown fields refused');
    assert.equal((await patch(c.id, admin, {})).status, 400);
  });

  test('POST /me/password: needs the current password', async () => {
    const me = await t.factory.staff({ role: 'consultant' });
    const call = (body) => request(app).post('/api/staff/me/password').set('Authorization', bearer(me)).send(body);
    const bad = await call({ currentPassword: 'wrong-password', newPassword: 'AnotherPass123' });
    assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_PASSWORD']);
    assert.equal((await call({ currentPassword: 'x', newPassword: 'short' })).status, 400);
  });
});

describe('AUTH-1 a consultant cannot take a colleague\'s chat through assign / handback', () => {
  test('owner and managers may; another consultant gets 409 naming the owner and nothing changes', async () => {
    const owner = await t.factory.staff({ role: 'consultant', name: 'Olivia Owner' });
    const other = await t.factory.staff({ role: 'consultant' });
    const manager = await t.factory.staff({ role: 'manager' });
    const client = await t.factory.client();
    const convo = await t.factory.conversation({ client_id: client.id, state: 'consultant_active' });
    await t.query('UPDATE conversations SET assigned_staff_id = $2 WHERE id = $1', [convo.id, owner.id]);
    const patch = (path, who, body) => request(app).patch(`/api/conversations/${convo.id}/${path}`).set('Authorization', bearer(who)).send(body);

    const steal = await patch('assign', other, { staffId: other.id });
    assert.deepEqual([steal.status, steal.body.code], [409, 'CONVERSATION_CLAIMED']);
    assert.match(steal.body.error, /Olivia Owner/);
    assert.equal((await patch('handback', other)).status, 409);
    let row = await t.one('SELECT state, assigned_staff_id FROM conversations WHERE id = $1', [convo.id]);
    assert.deepEqual([row.state, row.assigned_staff_id], ['consultant_active', owner.id]);

    assert.equal((await patch('assign', owner, { staffId: other.id })).status, 200, 'the owner hands it to a colleague');
    assert.equal((await patch('assign', manager, { staffId: owner.id })).status, 200, 'a manager may reassign');
    assert.equal((await patch('handback', owner)).status, 200);
    row = await t.one('SELECT state, assigned_staff_id FROM conversations WHERE id = $1', [convo.id]);
    assert.deepEqual([row.state, row.assigned_staff_id], ['main_menu', null]);
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
