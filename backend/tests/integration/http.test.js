// HTTP behaviour of the app factory against a real Postgres: request ids, the
// single error middleware, the size-run-sheet route, and the services moved out
// of controllers/routes (settings, conversations, broadcasts).
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const auth = await t.load('middleware/auth.js');
const { createApp } = await t.load('app.js');
const request = (await import('supertest')).default;

let app;
let admin;
let token;
before(() => { app = createApp(); });
beforeEach(async () => {
  await t.reset();
  admin = await t.factory.staff({ role: 'admin', name: 'Ada Admin' });
  token = `Bearer ${auth.generateToken(admin)}`;
});
after(() => t.stop());

const get = (path) => request(app).get(path).set('Authorization', token);

describe('request ids and error handling', () => {
  test('every response carries X-Request-Id; a sane incoming id is echoed back', async () => {
    const r = await request(app).get('/health');
    assert.match(r.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    const echoed = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    assert.equal(echoed.headers['x-request-id'], 'abc-123');
    const junk = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces <script>');
    assert.notEqual(junk.headers['x-request-id'], 'bad id with spaces <script>');
  });

  test('malformed JSON → 400, oversized body → 413, unknown route → 404 JSON', async () => {
    const bad = await request(app).post('/api/staff/login').set('Content-Type', 'application/json').send('{"email":');
    assert.deepEqual([bad.status, bad.body], [400, { error: 'Malformed JSON body' }]);
    const big = await request(app).post('/api/staff/login').set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1024 * 1024 + 10) }));
    assert.deepEqual([big.status, big.body], [413, { error: 'Request body too large' }]);
    const missing = await request(app).get('/nope');
    assert.deepEqual([missing.status, missing.body], [404, { error: 'Route not found' }]);
  });
});

describe('GET /api/orders/:id/size-run-sheet', () => {
  test('200 PDF with download headers', async () => {
    const client = await t.factory.client({ name: 'Dalpark Primary' });
    const q = await t.factory.quotation({ client_id: client.id, line_items: [{ name: 'Polo', sizes: [{ size: 'M', qty: 3 }] }] });
    const order = await t.factory.order({ client_id: client.id, quotation_id: q.id, reference: 'BRQ-O-00042' });
    const r = await get(`/api/orders/${order.id}/size-run-sheet`).buffer(true).parse((res, cb) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.headers['content-disposition'], 'attachment; filename="size-run-BRQ-O-00042.pdf"');
    assert.equal(Number(r.headers['content-length']), r.body.length);
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
  });

  test('non-UUID id → 400; unknown order → 404', async () => {
    const bad = await get('/api/orders/abc/size-run-sheet');
    assert.deepEqual([bad.status, bad.body], [400, { error: 'Invalid order id' }]);
    const missing = await get(`/api/orders/${crypto.randomUUID()}/size-run-sheet`);
    assert.deepEqual([missing.status, missing.body], [404, { error: 'Order not found' }]);
  });

  test('unexpected failure → 500 with a generic message', async () => {
    const order = await t.factory.order();
    await t.query('ALTER TABLE payments RENAME TO payments_hidden');
    try {
      const r = await get(`/api/orders/${order.id}/size-run-sheet`);
      assert.deepEqual([r.status, r.body], [500, { error: 'Failed to generate size run sheet' }]);
    } finally {
      await t.query('ALTER TABLE payments_hidden RENAME TO payments');
    }
  });
});

describe('settings (modules/settings/service.js)', () => {
  test('GET lists settings; PATCH updates; unknown key → 404; missing value → 400', async () => {
    const list = await get('/api/settings');
    assert.deepEqual(list.body, { settings: { busy_mode: 'false' } });
    const upd = await request(app).patch('/api/settings/busy_mode').set('Authorization', token).send({ value: true });
    assert.deepEqual([upd.status, upd.body], [200, { setting: { key: 'busy_mode', value: 'true' } }]);
    const unknown = await request(app).patch('/api/settings/nope').set('Authorization', token).send({ value: 1 });
    assert.deepEqual([unknown.status, unknown.body], [404, { error: 'Setting not found' }]);
    const empty = await request(app).patch('/api/settings/busy_mode').set('Authorization', token).send({});
    assert.deepEqual([empty.status, empty.body], [400, { error: 'value required' }]);
  });
});

/** Run queued jobs until none is left, including retries scheduled a little later. */
async function drainAll({ timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await t.drainJobs();
    const { n } = await t.one(`SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('pending', 'running')`);
    if (!n) return;
    if (Date.now() > deadline) throw new Error(`drainAll: ${n} job(s) still pending`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('conversations (modules/conversations/service.js)', () => {
  async function chat(state = 'awaiting_consultant') {
    const client = await t.factory.client({ name: 'Chatty', whatsapp_number: '27841112222' });
    const convo = await t.factory.conversation({ client_id: client.id, state });
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction) VALUES ($1, $2, 'hello?', 'inbound')`, [convo.id, client.id]);
    return { client, convo };
  }

  test('list / unread count / detail', async () => {
    const { convo } = await chat();
    const list = await get('/api/conversations');
    assert.equal(list.body.conversations.length, 1);
    assert.equal(list.body.conversations[0].last_message_body, 'hello?');
    assert.equal(Number(list.body.conversations[0].unread_count), 1);
    assert.deepEqual((await get('/api/conversations/unread-count')).body, { waiting: 1, unreadMessages: 1 });
    const detail = await get(`/api/conversations/${convo.id}`);
    assert.equal(detail.body.conversation.client_name, 'Chatty');
    assert.deepEqual(detail.body.messages.map((m) => m.body), ['hello?']);
    assert.equal((await get(`/api/conversations/${crypto.randomUUID()}`)).status, 404);
  });

  test('reply: queued through the outbox (recorded at once), sent by the worker, takes the chat over', async () => {
    const { convo } = await chat();
    const r = await request(app).post(`/api/conversations/${convo.id}/reply`).set('Authorization', token).send({ body: '  On it!  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, true);
    assert.equal(r.body.queued, true);
    const queued = await t.one(`SELECT * FROM messages WHERE id = $1`, [r.body.messageId]);
    assert.deepEqual([queued.body, queued.direction, queued.status, Number(queued.job_id)], ['On it!', 'outbound', 'queued', r.body.jobId]);
    assert.deepEqual(t.wa.texts('27841112222'), [], 'not sent inside the request');
    await t.drainJobs();
    assert.deepEqual(t.wa.texts('27841112222'), ['On it!']);
    const out = await t.one(`SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [convo.id]);
    assert.deepEqual([out.body, out.is_read_by_staff, out.status], ['On it!', true, 'sent']);
    assert.equal(out.meta_message_id, t.wa.sent[0].id);
    const cv = await t.one('SELECT state, assigned_staff_id FROM conversations WHERE id = $1', [convo.id]);
    assert.deepEqual([cv.state, cv.assigned_staff_id], ['consultant_active', admin.id]);
    const empty = await request(app).post(`/api/conversations/${convo.id}/reply`).set('Authorization', token).send({ body: '  ' });
    assert.equal(empty.status, 400);
  });

  test('claim: first wins, second gets 409 naming the owner', async () => {
    const { convo } = await chat();
    const other = await t.factory.staff({ name: 'Bob' });
    const a = await request(app).post(`/api/conversations/${convo.id}/claim`).set('Authorization', `Bearer ${auth.generateToken(other)}`);
    assert.equal(a.status, 200);
    const b = await request(app).post(`/api/conversations/${convo.id}/claim`).set('Authorization', token);
    assert.deepEqual([b.status, b.body], [409, { error: 'Already claimed by Bob' }]);
    assert.equal((await request(app).post(`/api/conversations/${crypto.randomUUID()}/claim`).set('Authorization', token)).status, 404);
  });

  test('takeover / handback (client told) / assign / read / close', async () => {
    const { convo } = await chat();
    assert.equal((await request(app).patch(`/api/conversations/${convo.id}/takeover`).set('Authorization', token)).body.conversation.state, 'consultant_active');
    const hb = await request(app).patch(`/api/conversations/${convo.id}/handback`).set('Authorization', token);
    assert.deepEqual([hb.body.conversation.state, hb.body.conversation.assigned_staff_id], ['main_menu', null]);
    await t.drainJobs();
    // Take-over tells the client who is helping them; hand-back that the team is done.
    assert.match(t.wa.texts('27841112222')[0], /from Braq Uni is now helping you/);
    assert.match(t.wa.texts('27841112222')[1], /finished assisting you/);
    assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outbound' AND status = 'sent'`, [convo.id])).n, 2,
      'both messages are in the conversation');
    const staff = await t.factory.staff();
    const as = await request(app).patch(`/api/conversations/${convo.id}/assign`).set('Authorization', token).send({ staffId: staff.id });
    assert.equal(as.body.conversation.assigned_staff_id, staff.id);
    const badStaff = await request(app).patch(`/api/conversations/${convo.id}/assign`).set('Authorization', token).send({ staffId: crypto.randomUUID() });
    assert.equal(badStaff.status, 400);
    assert.deepEqual((await request(app).patch(`/api/conversations/${convo.id}/read`).set('Authorization', token)).body, { ok: true });
    assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND NOT is_read_by_staff`, [convo.id])).n, 0);
    assert.equal((await request(app).patch(`/api/conversations/${convo.id}/close`).set('Authorization', token)).body.conversation.is_open, false);
  });

  test('takeover never silently steals another consultant\'s chat (admin / manager may)', async () => {
    const { convo } = await chat('consultant_active');
    const owner = await t.factory.staff({ name: 'Olive Owner' });
    const other = await t.factory.staff({ name: 'Otto Other' });
    const manager = await t.factory.staff({ name: 'Mo Manager', role: 'manager' });
    await t.query('UPDATE conversations SET assigned_staff_id = $2 WHERE id = $1', [convo.id, owner.id]);
    const as = (s) => `Bearer ${auth.generateToken(s)}`;

    const stolen = await request(app).patch(`/api/conversations/${convo.id}/takeover`).set('Authorization', as(other));
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.code, 'CONVERSATION_CLAIMED');
    assert.match(stolen.body.error, /Olive Owner/);
    assert.equal((await t.one('SELECT assigned_staff_id FROM conversations WHERE id = $1', [convo.id])).assigned_staff_id, owner.id);

    assert.equal((await request(app).patch(`/api/conversations/${convo.id}/takeover`).set('Authorization', as(owner))).status, 200, 'own chat');
    const mgr = await request(app).patch(`/api/conversations/${convo.id}/takeover`).set('Authorization', as(manager));
    assert.equal(mgr.status, 200);
    assert.equal(mgr.body.conversation.assigned_staff_id, manager.id);
    assert.equal((await request(app).patch(`/api/conversations/${crypto.randomUUID()}/takeover`).set('Authorization', token)).status, 404);
  });

  test('list filters: assignedToMe, clientId, search by name / number; paged envelope', async () => {
    const { client, convo } = await chat();
    const other = await t.factory.client({ name: 'Zola Zulu', whatsapp_number: '27849998888' });
    const otherConvo = await t.factory.conversation({ client_id: other.id });
    await t.query('UPDATE conversations SET assigned_staff_id = $2 WHERE id = $1', [otherConvo.id, admin.id]);

    const ids = (r) => r.body.items.map((c) => c.id).sort();
    const all = await get('/api/conversations');
    assert.deepEqual([all.body.total, all.body.page, all.body.items.length], [2, 1, 2]);
    assert.deepEqual(all.body.conversations, all.body.items, 'legacy key kept');
    assert.deepEqual(ids(await get('/api/conversations?assignedToMe=true')), [otherConvo.id]);
    assert.deepEqual(ids(await get(`/api/conversations?clientId=${client.id}`)), [convo.id]);
    assert.deepEqual(ids(await get('/api/conversations?search=chat')), [convo.id], 'name, case-insensitive');
    assert.deepEqual(ids(await get('/api/conversations?search=998888')), [otherConvo.id], 'number digits');
    assert.deepEqual(ids(await get('/api/conversations?search=%2B27%2084%20999')), [otherConvo.id], 'formatted number');
    assert.deepEqual(ids(await get('/api/conversations?search=100%25')), [], 'LIKE wildcards are literal');
    assert.equal((await get('/api/conversations?clientId=nope')).status, 400);
  });
});

describe('broadcasts (modules/broadcasts/service.js)', () => {
  const broadcastRow = (id) => t.one('SELECT * FROM broadcasts WHERE id = $1', [id]);

  test('custom message: 202 + queued row, fanned out to the audience, logged with counts', async () => {
    const corp = await t.factory.client({ client_type: 'corporate', whatsapp_number: '27850000001' });
    await t.factory.client({ client_type: 'retail', whatsapp_number: '27850000002' });
    const r = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: 'Hello corp', audience: 'corporate' });
    assert.equal(r.status, 202);
    assert.deepEqual([r.body.recipients, r.body.status, r.body.total, r.body.sent, r.body.failed], [1, 'queued', 1, 1, 0]);
    assert.equal(t.wa.sent.length, 0, 'nothing is sent inside the request');
    assert.equal((await broadcastRow(r.body.broadcastId)).status, 'queued');

    await drainAll();
    assert.deepEqual(t.wa.sent.map((m) => m.to), [corp.whatsapp_number]);
    const row = await broadcastRow(r.body.broadcastId);
    assert.deepEqual([row.status, row.sent_count, row.failed_count, row.recipient_count], ['done', 1, 0, 1]);
    const [log] = (await get('/api/broadcasts')).body.broadcasts;
    assert.deepEqual([log.message_type, log.body, log.recipient_count, log.sent_by_name], ['custom:corporate', 'Hello corp', 1, 'Ada Admin']);
  });

  test('a failed send is retried; one that never goes through is counted failed — the rest still go out', async () => {
    await t.factory.client({ whatsapp_number: '27850000003' });
    await t.factory.client({ whatsapp_number: '27850000004' });
    t.wa.failNext(1);
    // An unknown audience (even a prototype key) is refused — never "everyone" (SEC-4).
    const refused = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: 'x', audience: '__proto__' });
    assert.equal(refused.status, 400);
    const r = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: 'x', audience: 'all_clients' });
    assert.equal(r.body.recipients, 2, 'all_clients reaches every client');
    await drainAll();
    assert.deepEqual(t.wa.sent.map((m) => m.to).sort(), ['27850000003', '27850000004']);
    let row = await broadcastRow(r.body.broadcastId);
    assert.deepEqual([row.status, row.sent_count, row.failed_count], ['done', 2, 0]);

    t.wa.clear();
    t.wa.failNext(1000);
    const dead = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: 'y', audience: 'all_clients' });
    await drainAll();
    row = await broadcastRow(dead.body.broadcastId);
    assert.deepEqual([row.status, row.sent_count, row.failed_count], ['done', 0, 2]);
    assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM jobs WHERE type = 'whatsapp.send' AND status = 'dead'`)).n, 2);
    t.wa.clear();
  });

  test('re-running a fan-out sends nothing twice (dedupe per broadcast + recipient)', async () => {
    await t.factory.client({ whatsapp_number: '27850000007' });
    const r = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: 'once', audience: 'all_clients' });
    await drainAll();
    const fanout = (await t.jobs('broadcast.fanout'))[0];
    await t.query(`INSERT INTO jobs (type, payload) VALUES ('broadcast.fanout', $1)`, [fanout.payload]);
    await drainAll();
    assert.equal(t.wa.sent.length, 1);
    assert.equal((await broadcastRow(r.body.broadcastId)).sent_count, 1);
  });

  test('delay / busy notices go to clients with open orders only; nobody to send to → done at once', async () => {
    const open = await t.factory.client({ client_type: 'corporate', whatsapp_number: '27850000005' });
    const done = await t.factory.client({ client_type: 'corporate', whatsapp_number: '27850000006' });
    const o = await t.factory.order({ client_id: open.id, stage: 'in_production', reference: 'BRQ-O-00077' });
    await t.query(`UPDATE orders SET client_type = 'corporate' WHERE id = $1`, [o.id]);
    await t.factory.order({ client_id: done.id, stage: 'completed' });
    const d = await request(app).post('/api/broadcasts/delay').set('Authorization', token);
    assert.deepEqual([d.status, d.body.recipients], [202, 1]);
    await drainAll();
    assert.match(t.wa.texts('27850000005')[0], /BRQ-O-00077/);
    const b = await request(app).post('/api/broadcasts/busy').set('Authorization', token);
    assert.equal(b.body.total, 1);
    const empty = await request(app).post('/api/broadcasts/custom').set('Authorization', token).send({ message: ' ' });
    assert.equal(empty.status, 400);

    await t.query(`UPDATE orders SET stage = 'completed'`);
    const none = await request(app).post('/api/broadcasts/busy').set('Authorization', token);
    assert.deepEqual([none.status, none.body.recipients, none.body.status], [202, 0, 'done']);
    assert.equal((await t.jobs('broadcast.fanout')).filter((j) => j.payload.broadcastId === none.body.broadcastId).length, 0);
  });
});
