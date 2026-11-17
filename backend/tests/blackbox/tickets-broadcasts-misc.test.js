/**
 * Black-box API tests: broadcasts, tickets, conversations/inbox, settings, analytics.
 *
 * Tickets / conversations / orders / payments are created by the bot or other
 * flows, so fixtures are inserted with SQL; everything under test goes over HTTP.
 * Test order matters: the empty-recipient broadcast case runs first while the
 * fresh DB has no orders.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { startTestEnv, ADMIN, JWT_SECRET } from '../helpers/env.js';

let env;
let db;
let adminToken;
let adminId;
let consultant;
let consultant2;

// ── local helpers ────────────────────────────────────────────────────────────
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${env.baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const rnd = () => crypto.randomBytes(4).toString('hex');
const phone = () => `2771${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const num = (x) => Number(x ?? 0);

async function makeStaff(role) {
  const name = `${role} ${rnd()}`;
  const email = `${role}.${rnd()}@test.local`;
  const { rows } = await db.query(
    `INSERT INTO staff (name, email, password_hash, role) VALUES ($1,$2,'x',$3) RETURNING id`,
    [name, email, role],
  );
  const id = rows[0].id;
  return { id, name, email, token: jwt.sign({ id, email, role, name }, JWT_SECRET, { expiresIn: '1h' }) };
}

async function makeClient(type = 'corporate') {
  const { rows } = await db.query(
    `INSERT INTO clients (whatsapp_number, name, client_type) VALUES ($1,$2,$3) RETURNING *`,
    [phone(), `Client ${rnd()}`, type],
  );
  return rows[0];
}

async function makeOrder(client, stage = 'in_production', clientType = client.client_type) {
  const { rows } = await db.query(
    `INSERT INTO orders (reference, client_id, client_type, stage) VALUES ($1,$2,$3,$4) RETURNING *`,
    [`TST-O-${rnd()}`, client.id, clientType, stage],
  );
  return rows[0];
}

async function makeTicket(client, { status = 'open', slaHours = 4 } = {}) {
  const { rows } = await db.query(
    `INSERT INTO tickets (client_id, category, description, status, sla_due_at)
     VALUES ($1,'defective','Torn seam',$2, NOW() + ($3 || ' hours')::interval) RETURNING *`,
    [client.id, status, String(slaHours)],
  );
  return rows[0];
}

async function makeConversation(client, { state = 'awaiting_consultant', unread = 2 } = {}) {
  const { rows } = await db.query(
    `INSERT INTO conversations (client_id, state) VALUES ($1,$2) RETURNING *`, [client.id, state],
  );
  const convo = rows[0];
  for (let i = 0; i < unread; i++) {
    await db.query(
      `INSERT INTO messages (conversation_id, client_id, body, direction, created_at)
       VALUES ($1,$2,$3,'inbound', NOW() - ($4 || ' seconds')::interval)`,
      [convo.id, client.id, `hello ${i}`, String(10 - i)],
    );
  }
  return convo;
}

async function fiveHundreds(calls, token) {
  const bad = [];
  for (const [method, path, body] of calls) {
    const r = await api(method, path, { token, body });
    if (r.status >= 500) bad.push(`${method} ${path} -> ${r.status}`);
  }
  return bad;
}

const sentTo = (calls) => calls.map(c => c.body?.to);
const countOf = (arr, x) => arr.filter(v => v === x).length;

before(async () => {
  env = await startTestEnv();
  db = new pg.Client({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await api('POST', '/api/staff/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(r.status, 200, r.text);
  adminToken = r.json.token;
  adminId = r.json.staff.id;
  consultant = await makeStaff('consultant');
  consultant2 = await makeStaff('consultant');
}, { timeout: 240000 });

after(async () => {
  await db?.end().catch(() => {});
  await env?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('broadcasts', () => {
  test('empty recipient set: delay/busy send nothing, report 0 and still log history', async () => {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 0, 'precondition: fresh DB has no orders');
    env.clearFakeCalls();
    const d = await api('POST', '/api/broadcasts/delay', { token: adminToken, body: {} });
    assert.equal(d.status, 202, d.text);
    const counts = (j) => [j.recipients, j.status, j.sent, j.failed, j.total];
    assert.deepEqual(counts(d.json), [0, 'done', 0, 0, 0]);
    const b = await api('POST', '/api/broadcasts/busy', { token: adminToken, body: {} });
    assert.deepEqual(counts(b.json), [0, 'done', 0, 0, 0]);
    await env.waitForJobs({ all: true });
    assert.equal(env.fakeCalls('whatsapp').length, 0);

    const h = await api('GET', '/api/broadcasts', { token: adminToken });
    assert.equal(h.status, 200);
    const types = h.json.broadcasts.map(x => x.message_type);
    assert.ok(types.includes('delay') && types.includes('busy'));
    assert.ok(h.json.broadcasts.every(x => x.recipient_count === 0));
  });

  test('broadcast endpoints require auth', async () => {
    assert.equal((await api('GET', '/api/broadcasts')).status, 401);
    assert.equal((await api('POST', '/api/broadcasts/delay')).status, 401);
    assert.equal((await api('POST', '/api/broadcasts/busy')).status, 401);
  });

  describe('with active / completed / retail orders', () => {
    let corpTwo, corpDone, retail, cancelled;
    before(async () => {
      corpTwo = await makeClient('corporate');
      await makeOrder(corpTwo, 'deposit_pending');
      await makeOrder(corpTwo, 'ready');
      corpDone = await makeClient('corporate');
      await makeOrder(corpDone, 'completed');
      retail = await makeClient('retail');
      await makeOrder(retail, 'in_production');
      cancelled = await makeClient('school');
      await makeOrder(cancelled, 'cancelled');   // legacy stage value — must still be excluded from broadcasts
    });

    test('/delay messages every active non-retail order (one per order reference)', async () => {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM orders WHERE stage NOT IN ('completed','cancelled') AND client_type <> 'retail'`);
      env.clearFakeCalls();
      const r = await api('POST', '/api/broadcasts/delay', { token: adminToken });
      assert.equal(r.status, 202, r.text);
      assert.equal(r.json.total, rows[0].n);
      assert.equal(r.json.recipients, rows[0].n);
      await env.waitForJobs({ all: true });
      const to = sentTo(env.fakeCalls('whatsapp'));
      assert.equal(to.length, rows[0].n);
      assert.equal(countOf(to, corpTwo.whatsapp_number), 2);
      assert.equal(countOf(to, corpDone.whatsapp_number), 0);
      assert.equal(countOf(to, retail.whatsapp_number), 0);
      assert.equal(countOf(to, cancelled.whatsapp_number), 0);
      assert.ok(env.fakeCalls('whatsapp').every(c => /Order update/.test(c.body.text.body)));
    });

    test('/busy messages each client with an open order exactly once', async () => {
      const { rows } = await db.query(
        `SELECT COUNT(DISTINCT c.whatsapp_number)::int AS n FROM orders o JOIN clients c ON c.id = o.client_id
         WHERE o.stage NOT IN ('completed','cancelled')`);
      env.clearFakeCalls();
      const r = await api('POST', '/api/broadcasts/busy', { token: adminToken });
      assert.equal(r.status, 202);
      assert.deepEqual([r.json.sent, r.json.failed, r.json.total, r.json.recipients], [rows[0].n, 0, rows[0].n, rows[0].n]);
      await env.waitForJobs({ all: true });
      const to = sentTo(env.fakeCalls('whatsapp'));
      assert.equal(to.length, rows[0].n);
      assert.equal(countOf(to, corpTwo.whatsapp_number), 1);
      assert.equal(countOf(to, retail.whatsapp_number), 1);
      assert.equal(countOf(to, corpDone.whatsapp_number), 0);
      assert.equal(countOf(to, cancelled.whatsapp_number), 0);
    });

    test('/custom: validation and corporate audience targeting', async () => {
      assert.equal((await api('POST', '/api/broadcasts/custom', { token: adminToken, body: { message: '   ' } })).status, 400);
      const { rows } = await db.query(`SELECT COUNT(DISTINCT whatsapp_number)::int AS n FROM clients WHERE client_type = 'corporate'`);
      env.clearFakeCalls();
      const r = await api('POST', '/api/broadcasts/custom', { token: adminToken, body: { message: 'Hello corp', audience: 'corporate' } });
      assert.equal(r.status, 202);
      assert.deepEqual([r.json.sent, r.json.failed, r.json.total, r.json.recipients], [rows[0].n, 0, rows[0].n, rows[0].n]);
      await env.waitForJobs({ all: true });
      const to = sentTo(env.fakeCalls('whatsapp'));
      assert.ok(to.includes(corpTwo.whatsapp_number) && to.includes(corpDone.whatsapp_number));
      assert.ok(!to.includes(retail.whatsapp_number));
    });

    test('history records type, sender and recipient count, newest first', async () => {
      const r = await api('GET', '/api/broadcasts', { token: consultant.token });
      assert.equal(r.status, 200);
      const [latest, busy, delay] = r.json.broadcasts;
      assert.equal(latest.message_type, 'custom:corporate');
      assert.equal(latest.body, 'Hello corp');
      assert.equal(busy.message_type, 'busy');
      assert.equal(delay.message_type, 'delay');
      assert.ok(delay.recipient_count >= 2);
      assert.equal(delay.sent_by_name, ADMIN.name);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tickets', () => {
  let client, overdue, fresh, resolvedLate;
  before(async () => {
    client = await makeClient('retail');
    overdue = await makeTicket(client, { status: 'open', slaHours: -2 });
    fresh = await makeTicket(client, { status: 'open', slaHours: 4 });
    resolvedLate = await makeTicket(client, { status: 'resolved', slaHours: -10 });
  });

  test('list requires auth and returns tickets with client info + is_overdue', async () => {
    assert.equal((await api('GET', '/api/tickets')).status, 401);
    const r = await api('GET', '/api/tickets', { token: consultant.token });
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.tickets.map(t => [t.id, t]));
    assert.equal(byId[overdue.id].is_overdue, true);
    assert.equal(byId[fresh.id].is_overdue, false);
    assert.equal(byId[resolvedLate.id].is_overdue, false);
    assert.equal(byId[fresh.id].client_name, client.name);
  });

  test('filter by status and overdue=true', async () => {
    const open = await api('GET', '/api/tickets?status=open', { token: consultant.token });
    const ids = open.json.tickets.map(t => t.id);
    assert.ok(ids.includes(overdue.id) && ids.includes(fresh.id) && !ids.includes(resolvedLate.id));
    assert.ok(open.json.tickets.every(t => t.status === 'open'));

    const od = await api('GET', '/api/tickets?overdue=true', { token: consultant.token });
    const odIds = od.json.tickets.map(t => t.id);
    assert.ok(odIds.includes(overdue.id));
    assert.ok(!odIds.includes(fresh.id) && !odIds.includes(resolvedLate.id));
    assert.ok(od.json.tickets.every(t => t.is_overdue === true));
  });

  test('pagination: limit=1 returns one ticket', async () => {
    const r = await api('GET', '/api/tickets?limit=1&page=2', { token: consultant.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.tickets.length, 1);
  });

  test('invalid status filter / non-numeric pagination return 400 or 200, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/tickets?status=bogus'],
      ['GET', '/api/tickets?page=abc'],
      ['GET', '/api/tickets?limit=abc'],
    ], consultant.token);
    assert.deepEqual(bad, []);
  });

  test('get by id; unknown id → 404', async () => {
    const r = await api('GET', `/api/tickets/${overdue.id}`, { token: consultant.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.ticket.category, 'defective');
    assert.equal(r.json.ticket.is_overdue, true);
    assert.equal((await api('GET', `/api/tickets/${crypto.randomUUID()}`, { token: consultant.token })).status, 404);
  });

  test('PATCH status transitions: in_progress → resolved (sets resolved_at) → closed', async () => {
    const a = await api('PATCH', `/api/tickets/${fresh.id}`, { token: consultant.token, body: { status: 'in_progress' } });
    assert.equal(a.status, 200);
    assert.equal(a.json.ticket.status, 'in_progress');
    assert.equal(a.json.ticket.resolved_at, null);
    const b = await api('PATCH', `/api/tickets/${fresh.id}`, { token: consultant.token, body: { status: 'resolved' } });
    assert.equal(b.json.ticket.status, 'resolved');
    assert.ok(b.json.ticket.resolved_at);
    const c = await api('PATCH', `/api/tickets/${fresh.id}`, { token: consultant.token, body: { status: 'closed' } });
    assert.equal(c.json.ticket.status, 'closed');
  });

  test('reopening a resolved ticket clears resolved_at', async () => {
    const r = await api('PATCH', `/api/tickets/${resolvedLate.id}`, { token: adminToken, body: { status: 'resolved' } });
    assert.ok(r.json.ticket.resolved_at);
    const o = await api('PATCH', `/api/tickets/${resolvedLate.id}`, { token: adminToken, body: { status: 'open' } });
    assert.equal(o.status, 200);
    assert.equal(o.json.ticket.status, 'open');
    assert.equal(o.json.ticket.resolved_at, null, 'open ticket should not carry a resolved_at timestamp');
  });

  test('PATCH assignment and validation', async () => {
    const a = await api('PATCH', `/api/tickets/${overdue.id}`, { token: adminToken, body: { assignedStaffId: consultant.id } });
    assert.equal(a.status, 200);
    assert.equal(a.json.ticket.assigned_staff_id, consultant.id);
    const g = await api('GET', `/api/tickets/${overdue.id}`, { token: adminToken });
    assert.equal(g.json.ticket.assigned_name, consultant.name);

    assert.equal((await api('PATCH', `/api/tickets/${overdue.id}`, { token: adminToken, body: { status: 'done' } })).status, 400);
    assert.equal((await api('PATCH', `/api/tickets/${overdue.id}`, { token: adminToken, body: {} })).status, 400);
    assert.equal((await api('PATCH', `/api/tickets/${overdue.id}`, { token: adminToken, body: { assignedStaffId: 'bob' } })).status, 400);
    assert.equal((await api('PATCH', `/api/tickets/${crypto.randomUUID()}`, { token: adminToken, body: { status: 'open' } })).status, 404);
  });

  test('assigning a ticket to a non-existent staff id returns 400/404, not 500', async () => {
    const r = await api('PATCH', `/api/tickets/${overdue.id}`, { token: adminToken, body: { assignedStaffId: crypto.randomUUID() } });
    assert.ok(r.status === 400 || r.status === 404, `got ${r.status} ${r.text}`);
  });

  test('claim: first wins, second → 409, unknown → 404', async () => {
    const t = await makeTicket(client);
    const a = await api('POST', `/api/tickets/${t.id}/claim`, { token: consultant2.token });
    assert.equal(a.status, 200);
    assert.equal(a.json.ticket.assigned_staff_id, consultant2.id);
    const b = await api('POST', `/api/tickets/${t.id}/claim`, { token: consultant.token });
    assert.equal(b.status, 409);
    assert.match(b.json.error, new RegExp(consultant2.name));
    assert.equal((await api('POST', `/api/tickets/${crypto.randomUUID()}/claim`, { token: consultant.token })).status, 404);
  });

  test('non-UUID ticket ids return 400/404, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/tickets/xyz'],
      ['PATCH', '/api/tickets/xyz', { status: 'open' }],
      ['POST', '/api/tickets/xyz/claim'],
    ], adminToken);
    assert.deepEqual(bad, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('conversations / inbox', () => {
  let client, convo, baseline;
  before(async () => {
    const u = await api('GET', '/api/conversations/unread-count', { token: adminToken });
    baseline = u.json;
    client = await makeClient('corporate');
    convo = await makeConversation(client, { state: 'awaiting_consultant', unread: 2 });
  });

  test('requires auth', async () => {
    assert.equal((await api('GET', '/api/conversations')).status, 401);
  });

  test('unread-count reflects waiting conversations and unread inbound messages', async () => {
    const r = await api('GET', '/api/conversations/unread-count', { token: consultant.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.waiting - baseline.waiting, 1);
    assert.equal(r.json.unreadMessages - baseline.unreadMessages, 2);
  });

  test('list shows the open conversation with last message and unread count; state filter works', async () => {
    const r = await api('GET', '/api/conversations', { token: consultant.token });
    assert.equal(r.status, 200);
    const c = r.json.conversations.find(x => x.id === convo.id);
    assert.ok(c);
    assert.equal(c.client_wa_id, client.whatsapp_number);
    assert.equal(num(c.unread_count), 2);
    assert.equal(c.last_message_body, 'hello 1');
    assert.equal(c.last_message_direction, 'inbound');
    const f = await api('GET', '/api/conversations?state=main_menu', { token: consultant.token });
    assert.ok(!f.json.conversations.some(x => x.id === convo.id));
  });

  test('get by id returns conversation + messages in chronological order; unknown → 404', async () => {
    const r = await api('GET', `/api/conversations/${convo.id}`, { token: consultant.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.conversation.client_name, client.name);
    assert.deepEqual(r.json.messages.map(m => m.body), ['hello 0', 'hello 1']);
    assert.equal((await api('GET', `/api/conversations/${crypto.randomUUID()}`, { token: consultant.token })).status, 404);
  });

  test('mark read clears unread count', async () => {
    const r = await api('PATCH', `/api/conversations/${convo.id}/read`, { token: consultant.token });
    assert.equal(r.status, 200);
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND is_read_by_staff = false`, [convo.id]);
    assert.equal(rows[0].n, 0);
  });

  test('staff reply: empty body → 400; valid reply sends WhatsApp, stores outbound msg, moves to consultant_active', async () => {
    assert.equal((await api('POST', `/api/conversations/${convo.id}/reply`, { token: consultant.token, body: { body: '  ' } })).status, 400);
    assert.equal((await api('POST', `/api/conversations/${crypto.randomUUID()}/reply`, { token: consultant.token, body: { body: 'x' } })).status, 404);

    env.clearFakeCalls();
    const r = await api('POST', `/api/conversations/${convo.id}/reply`, { token: consultant.token, body: { body: '  Hi there  ' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.sent, true);
    assert.equal(r.json.queued, true);
    await env.waitForJobs();
    const wa = env.fakeCalls('whatsapp');
    assert.equal(wa.length, 1);
    assert.equal(wa[0].body.to, client.whatsapp_number);
    assert.equal(wa[0].body.text.body, 'Hi there');

    const g = await api('GET', `/api/conversations/${convo.id}`, { token: consultant.token });
    const last = g.json.messages.at(-1);
    assert.equal(last.direction, 'outbound');
    assert.equal(last.body, 'Hi there');
    assert.equal(last.id, r.json.messageId, 'the queued reply is the message row');
    assert.equal(last.status, 'sent');
    assert.match(last.meta_message_id, /^wamid\.FAKE_/, 'filled in once the worker sent it');
    assert.equal(g.json.conversation.state, 'consultant_active');
    assert.equal(g.json.conversation.assigned_staff_id, consultant.id);
  });

  test('handback returns to bot (main_menu), unassigns and notifies client; takeover re-assigns', async () => {
    env.clearFakeCalls();
    const h = await api('PATCH', `/api/conversations/${convo.id}/handback`, { token: consultant.token });
    assert.equal(h.status, 200);
    await env.waitForJobs();
    assert.equal(h.json.conversation.state, 'main_menu');
    assert.equal(h.json.conversation.assigned_staff_id, null);
    const wa = env.fakeCalls('whatsapp');
    assert.equal(wa.length, 1);
    assert.equal(wa[0].body.to, client.whatsapp_number);

    const t = await api('PATCH', `/api/conversations/${convo.id}/takeover`, { token: consultant2.token });
    assert.equal(t.status, 200);
    assert.equal(t.json.conversation.state, 'consultant_active');
    assert.equal(t.json.conversation.assigned_staff_id, consultant2.id);

    const mine = await api('GET', '/api/conversations?assignedToMe=true', { token: consultant2.token });
    assert.ok(mine.json.conversations.some(x => x.id === convo.id));
    const notMine = await api('GET', '/api/conversations?assignedToMe=true', { token: consultant.token });
    assert.ok(!notMine.json.conversations.some(x => x.id === convo.id));
  });

  test('claim is first-come: 200 then 409', async () => {
    const c2 = await makeConversation(await makeClient('retail'), { unread: 1 });
    const a = await api('POST', `/api/conversations/${c2.id}/claim`, { token: consultant.token });
    assert.equal(a.status, 200);
    assert.equal(a.json.conversation.assigned_staff_id, consultant.id);
    const b = await api('POST', `/api/conversations/${c2.id}/claim`, { token: consultant2.token });
    assert.equal(b.status, 409);
    assert.equal((await api('POST', `/api/conversations/${crypto.randomUUID()}/claim`, { token: consultant.token })).status, 404);
  });

  test('assign: missing staffId → 400, valid → 200, unknown conversation → 404', async () => {
    assert.equal((await api('PATCH', `/api/conversations/${convo.id}/assign`, { token: adminToken, body: {} })).status, 400);
    const r = await api('PATCH', `/api/conversations/${convo.id}/assign`, { token: adminToken, body: { staffId: consultant.id } });
    assert.equal(r.status, 200);
    assert.equal(r.json.conversation.assigned_staff_id, consultant.id);
    assert.equal((await api('PATCH', `/api/conversations/${crypto.randomUUID()}/assign`, { token: adminToken, body: { staffId: consultant.id } })).status, 404);
  });

  test('assigning a conversation to an unknown/garbage staffId returns 400/404, not 500', async () => {
    const bad = await fiveHundreds([
      ['PATCH', `/api/conversations/${convo.id}/assign`, { staffId: crypto.randomUUID() }],
      ['PATCH', `/api/conversations/${convo.id}/assign`, { staffId: 'bob' }],
    ], adminToken);
    assert.deepEqual(bad, []);
  });

  test('close hides it from the default list; isOpen=false shows it', async () => {
    const r = await api('PATCH', `/api/conversations/${convo.id}/close`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.conversation.is_open, false);
    const open = await api('GET', '/api/conversations?limit=200', { token: adminToken });
    assert.ok(!open.json.conversations.some(x => x.id === convo.id));
    const closed = await api('GET', '/api/conversations?isOpen=false', { token: adminToken });
    assert.ok(closed.json.conversations.some(x => x.id === convo.id));
  });

  test('non-UUID conversation ids / non-numeric paging return 400/404, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/conversations/nope'],
      ['POST', '/api/conversations/nope/reply', { body: 'hi' }],
      ['PATCH', '/api/conversations/nope/takeover'],
      ['PATCH', '/api/conversations/nope/handback'],
      ['PATCH', '/api/conversations/nope/close'],
      ['PATCH', '/api/conversations/nope/read'],
      ['POST', '/api/conversations/nope/claim'],
      ['GET', '/api/conversations?limit=abc'],
    ], adminToken);
    assert.deepEqual(bad, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('settings', () => {
  test('admin reads settings; busy_mode defaults to "false"', async () => {
    const r = await api('GET', '/api/settings', { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.busy_mode, 'false');
  });

  test('consultant forbidden, unauthenticated 401', async () => {
    assert.equal((await api('GET', '/api/settings', { token: consultant.token })).status, 403);
    assert.equal((await api('PATCH', '/api/settings/busy_mode', { token: consultant.token, body: { value: true } })).status, 403);
    assert.equal((await api('GET', '/api/settings')).status, 401);
  });

  test('PATCH updates an existing key (stringified); unknown key 404; missing value 400', async () => {
    const r = await api('PATCH', '/api/settings/busy_mode', { token: adminToken, body: { value: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.setting, { key: 'busy_mode', value: 'true' });
    const g = await api('GET', '/api/settings', { token: adminToken });
    assert.equal(g.json.settings.busy_mode, 'true');
    assert.equal((await api('PATCH', '/api/settings/no_such_key', { token: adminToken, body: { value: 'x' } })).status, 404);
    assert.equal((await api('PATCH', '/api/settings/busy_mode', { token: adminToken, body: {} })).status, 400);
    const reset = await api('PATCH', '/api/settings/busy_mode', { token: adminToken, body: { value: 'false' } });
    assert.equal(reset.json.setting.value, 'false');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('analytics', () => {
  let before1;
  let topClient;
  const product = `Prod-${rnd()}`;

  before(async () => {
    before1 = (await api('GET', '/api/analytics/revenue', { token: adminToken })).json;

    topClient = await makeClient('corporate');
    const o1 = await makeOrder(topClient, 'in_production');
    const o2 = await makeOrder(topClient, 'completed');
    const pay = (o, type, amt, when) => db.query(
      `INSERT INTO payments (order_id, type, amount, created_at) VALUES ($1,$2,$3, ${when})`, [o.id, type, amt]);
    await pay(o1, 'deposit', 600000, 'NOW()');
    await pay(o1, 'balance', 400000, `DATE_TRUNC('month', NOW()) - INTERVAL '10 days'`);
    await pay(o2, 'full', 100000, `NOW() - INTERVAL '13 months'`);

    const q = (status, qty) => db.query(
      `INSERT INTO quotations (reference, client_id, status, line_items) VALUES ($1,$2,$3,$4)`,
      [`TST-A-${rnd()}`, topClient.id, status, JSON.stringify([{ name: product, quantity: qty, lineTotal: 1 }])]);
    await q('accepted', 5000);
    await q('accepted', 4999);
    await q('rejected', 1);
    await q('sent', 100000);   // not accepted → must not count toward best-sellers
    await q('draft', 1);
    await q('expired', 1);
  });

  test('requires auth', async () => {
    assert.equal((await api('GET', '/api/analytics/revenue')).status, 401);
  });

  test('revenue summary: this month / last month / all time deltas match seeded payments', async () => {
    const r = await api('GET', '/api/analytics/revenue', { token: adminToken });
    assert.equal(r.status, 200);
    const s = r.json.summary, b = before1.summary;
    assert.equal(num(s.this_month) - num(b.this_month), 600000);
    assert.equal(num(s.last_month) - num(b.last_month), 400000);
    assert.equal(num(s.all_time) - num(b.all_time), 1100000);

    const month = (await db.query(`SELECT TO_CHAR(NOW(),'YYYY-MM') AS m`)).rows[0].m;
    const cur = r.json.byMonth.find(x => x.month === month);
    const prev = before1.byMonth.find(x => x.month === month);
    assert.equal(num(cur?.revenue) - num(prev?.revenue), 600000);
    assert.ok(r.json.byMonth.every(x => /^\d{4}-\d{2}$/.test(x.month)));
    assert.ok(r.json.byMonth.length <= 13);
  });

  test('quotation conversion counts and percentage are consistent', async () => {
    const r = await api('GET', '/api/analytics/revenue', { token: adminToken });
    const c = r.json.conversion, b = before1.conversion;
    assert.equal(num(c.total) - num(b.total), 6);
    assert.equal(num(c.accepted) - num(b.accepted), 2);
    assert.equal(num(c.rejected) - num(b.rejected), 1);
    assert.equal(num(c.sent) - num(b.sent), 1);
    assert.equal(num(c.draft) - num(b.draft), 1);
    assert.equal(num(c.expired) - num(b.expired), 1);
    // expired quotations count as lost opportunities, so they are in the denominator
    const denom = num(c.sent) + num(c.accepted) + num(c.rejected) + num(c.expired);
    assert.equal(num(c.conversion_pct), Math.round(1000 * num(c.accepted) / denom) / 10);
  });

  test('stage breakdown counts active orders only', async () => {
    const r = await api('GET', '/api/analytics/revenue', { token: adminToken });
    const get = (rows, st) => num(rows.find(x => x.stage === st)?.count);
    assert.equal(get(r.json.stageBreakdown, 'in_production') - get(before1.stageBreakdown, 'in_production'), 1);
    assert.ok(!r.json.stageBreakdown.some(x => x.stage === 'completed'));
  });

  test('top clients: biggest spender first with correct totals', async () => {
    const r = await api('GET', '/api/analytics/top-clients?limit=1', { token: adminToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.clients.length, 1);
    const [c] = r.json.clients;
    assert.equal(c.id, topClient.id);
    assert.equal(num(c.total_spent), 1100000);
    assert.equal(num(c.total_orders), 2);
  });

  test('top products: sums quantities over accepted quotations only', async () => {
    const r = await api('GET', '/api/analytics/top-products?limit=1', { token: adminToken });
    assert.equal(r.status, 200);
    const [p] = r.json.products;
    assert.equal(p.product, product);
    assert.equal(num(p.total_qty), 9999);
    assert.equal(num(p.appearances), 2);
  });

  test('negative limit returns 400 or a default-sized list, not 500', async () => {
    const bad = await fiveHundreds([
      ['GET', '/api/analytics/top-clients?limit=-1'],
      ['GET', '/api/analytics/top-products?limit=-5'],
    ], adminToken);
    assert.deepEqual(bad, []);
  });
});
