/**
 * Black-box API tests — orders: creation, reference numbering, stage machine,
 * hold/delay, consultant assignment, digital proof gate, payments.
 *
 * Tests named "BUG: ..." assert the CORRECT behaviour and currently fail
 * because of a genuine defect in the app (see the test comments).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startTestEnv, ADMIN } from '../helpers/env.js';

let env;
let db;
let token;
let adminId;

before(async () => {
  env = await startTestEnv();
  db = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false }, max: 3 });
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  token = j.token;
  adminId = j.staff.id;
}, { timeout: 240000 });

after(async () => {
  await db?.end().catch(() => {});
  await env?.stop();
});

// ── local helpers ─────────────────────────────────────────────────────────────
let requestCount = 0;
async function api(method, path, body, { raw = false, auth = true } = {}) {
  requestCount++;
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(`${env.baseUrl}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const randPhone = () => `2771${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

async function makeClient(overrides = {}) {
  const phone = overrides.whatsapp_number || randPhone();
  const { rows } = await db.query(
    `INSERT INTO clients (whatsapp_number, name, client_type, organisation, physical_address)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [phone, overrides.name ?? `Client ${phone}`, overrides.client_type ?? 'corporate',
      overrides.organisation ?? 'Acme Ltd', overrides.physical_address ?? '1 Main Rd, Brakpan'],
  );
  return rows[0];
}

// Every order comes from a quotation; the dashboard path builds one from line items.
// 10 × R100 = R1000 + 15% VAT = R1150 → deposit R690, balance R460.
const ITEMS = [{ name: 'Golf shirt', quantity: 10, unitPrice: 100 }];
async function makeOrder(clientId, extra = {}) {
  const r = await api('POST', '/api/orders', { clientId, lineItems: ITEMS, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json.order;
}

/** Record a payment (production needs the deposit, completion needs full payment). */
async function pay(orderId, type, amount) {
  const r = await api('POST', `/api/orders/${orderId}/payments`, { type, amount });
  assert.equal(r.status, 201, r.text);
  return r.json.payment;
}

const refNum = (ref) => Number(/^BRQ-O-(\d{5,})$/.exec(ref)?.[1]);

/** WhatsApp text bodies the fake Meta API received for a given recipient. */
function waTextsTo(phone) {
  return env.fakeCalls('whatsapp')
    .filter((c) => c.body?.to === phone && c.body?.type === 'text')
    .map((c) => c.body.text.body);
}

/** Side effects (WhatsApp) run on the job worker: wait until the queue is drained. */
async function settle() { await env.waitForJobs(); }

const NIL_UUID = '00000000-0000-4000-8000-000000000000';

// ═════════════════════════════════════════════════════════════════════════════
describe('auth', () => {
  test('orders API requires a bearer token', async () => {
    const r = await api('GET', '/api/orders', undefined, { auth: false });
    assert.equal(r.status, 401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('create order', () => {
  test('valid order is created at deposit_pending with a BRQ-O-NNNNN reference and initial history', async () => {
    const client = await makeClient();
    const r = await api('POST', '/api/orders', { clientId: client.id, clientType: 'school', poNumber: 'PO-123', lineItems: ITEMS });
    assert.equal(r.status, 201, r.text);
    const o = r.json.order;
    assert.match(o.reference, /^BRQ-O-\d{5}$/);
    assert.equal(o.stage, 'deposit_pending');
    assert.equal(o.client_id, client.id);
    assert.equal(o.client_type, 'school');
    assert.equal(o.po_number, 'PO-123');
    assert.equal(o.assigned_staff_id, adminId, 'defaults to the creating staff member');
    assert.equal(o.payment_status, 'unpaid');
    assert.ok(o.quotation_id, 'created through an accepted quotation');
    assert.deepEqual([Number(o.total_amount), Number(o.deposit_amount), Number(o.balance_amount)], [1150, 690, 460]);

    const g = await api('GET', `/api/orders/${o.id}`);
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.order.client_name, client.name);
    assert.equal(g.json.history.length, 1);
    assert.equal(g.json.history[0].stage, 'deposit_pending');
    assert.equal(g.json.history[0].changed_by, adminId);
    assert.deepEqual(g.json.payments, []);
    assert.equal(g.json.stageInfo.percent, 25);
  });

  test('invalid payloads are rejected with 400', async () => {
    const client = await makeClient();
    const cases = [
      ['missing clientId', { lineItems: ITEMS }],
      ['non-uuid clientId', { clientId: 'abc', lineItems: ITEMS }],
      ['numeric clientId', { clientId: 42, lineItems: ITEMS }],
      ['unknown clientType', { clientId: client.id, clientType: 'alien', lineItems: ITEMS }],
      ['non-uuid quotationId', { clientId: client.id, quotationId: 'q-1' }],
      ['non-uuid assignedStaffId', { clientId: client.id, assignedStaffId: 'me', lineItems: ITEMS }],
      ['numeric poNumber', { clientId: client.id, poNumber: 123, lineItems: ITEMS }],
      ['neither quotationId nor lineItems', { clientId: client.id }],
      ['empty lineItems', { clientId: client.id, lineItems: [] }],
      ['line item without a name', { clientId: client.id, lineItems: [{ quantity: 1, unitPrice: 5 }] }],
    ];
    for (const [label, body] of cases) {
      const r = await api('POST', '/api/orders', body);
      assert.equal(r.status, 400, `${label}: ${r.status} ${r.text}`);
    }
  });

  // express.json() raises a SyntaxError with status 400 / type
  // 'entity.parse.failed', but the global error handler (src/index.js:67-70)
  // ignores err.status and always answers 500.
  test('malformed JSON body returns 400, not 500', async () => {
    const bad = await api('POST', '/api/orders', '{"clientId":', { raw: true });
    assert.equal(bad.status, 400, `malformed JSON: ${bad.status} ${bad.text}`);
  });

  // orders.service.js createOrder (~line 104) inserts without checking the
  // client exists; the FK violation bubbles to handleError → 500.
  test('unknown (well-formed) clientId returns 404/400, not 500', async () => {
    const r = await api('POST', '/api/orders', { clientId: NIL_UUID, lineItems: ITEMS });
    assert.ok([400, 404, 422].includes(r.status), `got ${r.status} ${r.text}`);
  });

  test('unknown assignedStaffId returns 4xx, not 500', async () => {
    const client = await makeClient();
    const r = await api('POST', '/api/orders', { clientId: client.id, assignedStaffId: NIL_UUID, lineItems: ITEMS });
    assert.ok([400, 404, 422].includes(r.status), `got ${r.status} ${r.text}`);
  });

  test('unknown quotationId returns 4xx, not 500', async () => {
    const client = await makeClient();
    const r = await api('POST', '/api/orders', { clientId: client.id, quotationId: NIL_UUID });
    assert.ok([400, 404, 422].includes(r.status), `got ${r.status} ${r.text}`);
  });

  test('concurrent creates get unique, contiguous references', async () => {
    const client = await makeClient();
    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () => api('POST', '/api/orders', { clientId: client.id, lineItems: ITEMS })));
    for (const r of results) assert.equal(r.status, 201, r.text);
    const nums = results.map((r) => refNum(r.json.order.reference)).sort((a, b) => a - b);
    assert.equal(new Set(nums).size, N, `duplicate refs: ${nums}`);
    assert.equal(nums[N - 1] - nums[0], N - 1, `refs not contiguous: ${nums}`);

    const next = await makeOrder(client.id);
    assert.equal(refNum(next.reference), nums[N - 1] + 1, 'next sequential create continues the sequence');
  });

  // nextOrderRef() (orders.service.js:8-18) commits the counter in its own
  // transaction BEFORE the order INSERT, so any failed insert burns a number.
  test('a failed create does not burn an order reference number', async () => {
    const client = await makeClient();
    const a = await makeOrder(client.id);
    await api('POST', '/api/orders', { clientId: NIL_UUID, lineItems: ITEMS }); // fails (unknown client)
    const b = await makeOrder(client.id);
    assert.equal(refNum(b.reference), refNum(a.reference) + 1, `${a.reference} -> ${b.reference}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('stage machine', () => {
  test('advance through every stage to completed: history, WhatsApp per stage, percent, final-stage guard', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await pay(order.id, 'full', 1150);   // paid up front: neither the deposit nor the balance guard applies
    await env.waitForJobs(); env.clearFakeCalls();

    const expected = [
      ['deposit_pending', 'in_production', `In Production — Ref: ${order.reference}`, 50],
      ['in_production', 'ready', `Ready for Collection — Ref: ${order.reference}`, 75],
      ['ready', 'completed', `Order Complete — Ref: ${order.reference}`, 100],
    ];
    for (const [from, to, msg, pct] of expected) {
      const r = await api('POST', `/api/orders/${order.id}/advance`, { notes: `to ${to}` });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.from, from);
      assert.equal(r.json.to, to);
      assert.equal(r.json.order.stage, to);
      await settle(100);
      const texts = waTextsTo(client.whatsapp_number);
      assert.ok(texts.some((t) => t.includes(msg)), `expected WhatsApp "${msg}" to ${client.whatsapp_number}; got ${JSON.stringify(texts)}`);
      const g = await api('GET', `/api/orders/${order.id}`);
      assert.equal(g.json.stageInfo.percent, pct, `percent at ${to}`);
    }

    // Each transition notified the client exactly once, and only this client.
    const all = env.fakeCalls('whatsapp');
    assert.equal(all.length, 3, JSON.stringify(all.map((c) => c.body?.to)));
    assert.ok(all.every((c) => c.body.to === client.whatsapp_number));

    const g = await api('GET', `/api/orders/${order.id}`);
    assert.deepEqual(g.json.history.map((h) => h.stage), ['deposit_pending', 'in_production', 'ready', 'completed']);
    assert.deepEqual(g.json.history.slice(1).map((h) => h.notes), ['to in_production', 'to ready', 'to completed']);
    assert.ok(g.json.history.slice(1).every((h) => h.changed_by === adminId && h.changed_by_name === ADMIN.name));
    assert.equal(g.json.stageInfo.isLast, true);

    // Cannot advance past completed — no side effects.
    await env.waitForJobs(); env.clearFakeCalls();
    const past = await api('POST', `/api/orders/${order.id}/advance`, {});
    assert.equal(past.status, 400, past.text);
    await settle(100);
    assert.equal(env.fakeCalls('whatsapp').length, 0);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM order_stage_history WHERE order_id=$1', [order.id]);
    assert.equal(rows[0].n, 4);
  });

  test('estimatedCompletion is stored and quoted; delivery + tracking number uses the dispatch template', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await pay(order.id, 'deposit', 690);
    await env.waitForJobs(); env.clearFakeCalls();

    const r1 = await api('POST', `/api/orders/${order.id}/advance`, { estimatedCompletion: '2030-03-15' });
    assert.equal(r1.status, 200, r1.text);
    assert.ok(String(r1.json.order.estimated_completion_date).startsWith('2030-03-1'), r1.json.order.estimated_completion_date);
    const r2 = await api('POST', `/api/orders/${order.id}/advance`, { deliveryType: 'delivery', trackingNumber: 'TRK-998877' });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.order.tracking_number, 'TRK-998877');
    await settle();

    const texts = waTextsTo(client.whatsapp_number);
    assert.ok(texts[0]?.includes('Estimated completion') && texts[0].includes('2030'), texts[0]);
    assert.ok(texts[1]?.includes(`Order Dispatched — Ref: ${order.reference}`), texts[1]);
    assert.ok(texts[1]?.includes('TRK-998877'), texts[1]);
  });

  test('invalid advance payloads are rejected with 400; unknown order is 404', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    for (const body of [{ deliveryType: 'teleport' }, { notes: 5 }, { trackingNumber: ['x'] }]) {
      const r = await api('POST', `/api/orders/${order.id}/advance`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    }
    const nf = await api('POST', `/api/orders/${NIL_UUID}/advance`, {});
    assert.equal(nf.status, 404, nf.text);
    const g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(g.json.order.stage, 'deposit_pending', 'rejected advances must not move the order');
  });

  // AdvanceStageSchema accepts any string for estimatedCompletion
  // (orders.controller.js:19); Postgres then rejects the DATE cast → 500.
  test('unparseable estimatedCompletion returns 400, not 500', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const r = await api('POST', `/api/orders/${order.id}/advance`, { estimatedCompletion: 'next tuesday-ish' });
    assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
  });

  // advanceOrderStage (orders.service.js:180-205) reads the stage, then UPDATEs
  // by id without a row lock or "WHERE stage = <from>" guard, so concurrent
  // advances all compute the same `to`, write duplicate history and spam the client.
  test('concurrent advances do not double-apply the same transition', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await pay(order.id, 'full', 1150);
    await env.waitForJobs(); env.clearFakeCalls();
    const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', `/api/orders/${order.id}/advance`, {})));
    const ok = results.filter((r) => r.status === 200);
    const tos = ok.map((r) => r.json.to);
    await settle();
    const { rows } = await db.query(
      `SELECT stage FROM order_stage_history WHERE order_id=$1 AND stage <> 'deposit_pending'`, [order.id]);
    assert.equal(new Set(tos).size, tos.length, `same transition applied more than once: ${JSON.stringify(tos)}`);
    assert.equal(rows.length, new Set(rows.map((x) => x.stage)).size, `duplicate history rows: ${JSON.stringify(rows)}`);
    assert.equal(waTextsTo(client.whatsapp_number).length, ok.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('hold / delay', () => {
  test('held order cannot advance; supplier_delay notifies the client; release clears reason', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await pay(order.id, 'deposit', 690);
    await env.waitForJobs(); env.clearFakeCalls();

    const h = await api('PATCH', `/api/orders/${order.id}/hold`, { isOnHold: true, holdReason: 'supplier_delay' });
    assert.equal(h.status, 200, h.text);
    assert.equal(h.json.order.is_on_hold, true);
    assert.equal(h.json.order.hold_reason, 'supplier_delay');
    await settle();
    const texts = waTextsTo(client.whatsapp_number);
    assert.equal(texts.length, 1, JSON.stringify(texts));
    assert.ok(texts[0].includes(`Order update — ${order.reference}`) && texts[0].includes('supplier'), texts[0]);

    // Lifecycle guard HOLD: 409 with a code (was a plain 400), never overridable.
    const adv = await api('POST', `/api/orders/${order.id}/advance`, {});
    assert.equal(adv.status, 409, adv.text);
    assert.deepEqual([adv.json.code, adv.json.overridable], ['HOLD', false]);

    const rel = await api('PATCH', `/api/orders/${order.id}/hold`, { isOnHold: false, holdReason: 'ignored' });
    assert.equal(rel.status, 200, rel.text);
    assert.equal(rel.json.order.is_on_hold, false);
    assert.equal(rel.json.order.hold_reason, null);
    const adv2 = await api('POST', `/api/orders/${order.id}/advance`, {});
    assert.equal(adv2.status, 200, adv2.text);
  });

  test('non-supplier hold reason does not message the client; bad payload 400; unknown order 404', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await env.waitForJobs(); env.clearFakeCalls();
    const h = await api('PATCH', `/api/orders/${order.id}/hold`, { isOnHold: true, holdReason: 'awaiting_artwork' });
    assert.equal(h.status, 200, h.text);
    await settle();
    assert.equal(waTextsTo(client.whatsapp_number).length, 0);

    const bad = await api('PATCH', `/api/orders/${order.id}/hold`, { isOnHold: 'yes' });
    assert.equal(bad.status, 400, bad.text);
    const nf = await api('PATCH', `/api/orders/${NIL_UUID}/hold`, { isOnHold: true });
    assert.equal(nf.status, 404, nf.text);
  });

  // README documents POST /api/orders/:id/delay ("Flag as delayed → notifies
  // client") but orders.routes.js has no such route.
  test('documented POST /api/orders/:id/delay endpoint exists and notifies the client', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await env.waitForJobs(); env.clearFakeCalls();
    const r = await api('POST', `/api/orders/${order.id}/delay`, { reason: 'supplier_delay' });
    assert.ok(r.status >= 200 && r.status < 300, `got ${r.status} ${r.text}`);
    await settle();
    assert.ok(waTextsTo(client.whatsapp_number).length >= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('assign consultant', () => {
  test('assigning an existing staff member updates the order', async () => {
    const email = `consultant${Date.now()}@test.local`;
    const s = await api('POST', '/api/staff', { name: 'Connie Consultant', email, password: 'Password123!', role: 'consultant' });
    assert.equal(s.status, 201, s.text);
    const staffId = s.json.staff?.id ?? s.json.id;
    assert.ok(staffId, s.text);

    const client = await makeClient();
    const order = await makeOrder(client.id);
    const r = await api('PATCH', `/api/orders/${order.id}/assign`, { staffId });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.order.assigned_staff_id, staffId);
    const g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(g.json.order.staff_name, 'Connie Consultant');

    const missing = await api('PATCH', `/api/orders/${order.id}/assign`, {});
    assert.equal(missing.status, 400, missing.text);
    const nf = await api('PATCH', `/api/orders/${NIL_UUID}/assign`, { staffId });
    assert.equal(nf.status, 404, nf.text);
  });

  // assign() (orders.controller.js:121-130) only checks staffId is truthy; the
  // service UPDATEs blindly, so FK / uuid-cast errors surface as 500.
  test('assigning an unknown or malformed staffId returns 4xx, not 500', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const statuses = [];
    for (const staffId of [NIL_UUID, 'not-a-uuid', 12345]) {
      const r = await api('PATCH', `/api/orders/${order.id}/assign`, { staffId });
      statuses.push(`${JSON.stringify(staffId)}=>${r.status}`);
    }
    assert.ok(statuses.every((s) => /=>4\d\d$/.test(s)), statuses.join(', '));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('digital proof / design approval gate', () => {
  test('proof status endpoint validates status values', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const noUrl = await api('POST', `/api/orders/${order.id}/proof`, {});
    assert.equal(noUrl.status, 400, noUrl.text);
    const bad = await api('PATCH', `/api/orders/${order.id}/proof/status`, { status: 'whatever' });
    assert.equal(bad.status, 400, bad.text);
    // Proof machine: nothing to approve before a proof was sent (409), then approve works.
    const early = await api('PATCH', `/api/orders/${order.id}/proof/status`, { status: 'approved' });
    assert.equal(early.status, 409, early.text);
    assert.equal(early.json.code, 'PROOF_TRANSITION');
    const sent = await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.com/p0.png' });
    assert.equal(sent.status, 200, sent.text);
    const ok = await api('PATCH', `/api/orders/${order.id}/proof/status`, { status: 'approved', notes: 'lgtm' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.order.proof_status, 'approved');
  });

  // sendProofToClient (orders.service.js ~355-377) only updates the DB and the
  // conversation state; it never sends the PROOF_SENT WhatsApp message, so the
  // client never sees the proof (the bot only re-sends it if the client writes first).
  test('sending a proof delivers it to the client over WhatsApp', async () => {
    const client = await makeClient();
    await db.query(`INSERT INTO conversations (client_id, state) VALUES ($1,'main_menu')`, [client.id]);
    const order = await makeOrder(client.id);
    await env.waitForJobs(); env.clearFakeCalls();
    const url = 'https://example.com/proofs/p1.png';
    const r = await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: url, notes: 'Front logo 8cm' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.order.proof_status, 'sent');
    const { rows } = await db.query('SELECT state FROM conversations WHERE client_id=$1', [client.id]);
    assert.equal(rows[0].state, 'proof_review');
    await settle();
    const calls = env.fakeCalls('whatsapp').filter((c) => c.body?.to === client.whatsapp_number);
    assert.ok(calls.some((c) => JSON.stringify(c.body).includes(url)), `no WhatsApp with proof sent: ${JSON.stringify(calls)}`);
  });

  // README: "customer must reply APPROVE before this can advance"; PROOF_SENT
  // template: "We'll hold production until you confirm." advanceOrderStage
  // (orders.service.js:180-200) never checks proof_status.
  test('order with a pending (unapproved) proof cannot advance into production', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const p = await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.com/p.png' });
    assert.equal(p.status, 200, p.text);
    const r = await api('POST', `/api/orders/${order.id}/advance`, {});
    assert.ok([400, 409].includes(r.status), `advanced while proof pending: ${r.status} ${r.text}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('payments', () => {
  test('deposit then full payment: rows stored, status transitions, listing and order detail', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const d = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 690, notes: 'EFT' });
    assert.equal(d.status, 201, d.text);
    assert.equal(d.json.payment.type, 'deposit');
    assert.equal(Number(d.json.payment.amount), 690);
    assert.equal(d.json.payment.currency, 'ZAR');

    let g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(g.json.order.payment_status, 'deposit_paid');

    // FIN-9: a foreign currency would be summed into rand totals — refused, nothing stored.
    const usd = await api('POST', `/api/orders/${order.id}/payments`, { type: 'full', amount: 460, currency: 'USD' });
    assert.equal(usd.status, 400, usd.text);
    const f = await api('POST', `/api/orders/${order.id}/payments`, { type: 'full', amount: 460, currency: 'ZAR' });
    assert.equal(f.status, 201, f.text);
    assert.equal(f.json.payment.currency, 'ZAR');

    const l = await api('GET', `/api/orders/${order.id}/payments`);
    assert.equal(l.status, 200);
    assert.equal(l.json.payments.length, 2);
    assert.deepEqual(l.json.payments.map((p) => Number(p.amount)).sort(), [460, 690]);

    g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(g.json.order.payment_status, 'paid_in_full');
    assert.equal(g.json.payments.length, 2);
  });

  test('invalid payment payloads are rejected with 400 and nothing is stored', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const cases = [
      { type: 'deposit', amount: 0 },
      { type: 'deposit', amount: -50 },
      { type: 'deposit', amount: '100' },
      { type: 'deposit', amount: null },
      { type: 'deposit' },
      { type: 'refund', amount: 10 },
      { amount: 10 },
      { type: 'deposit', amount: 10, currency: 'RAND' },
    ];
    for (const body of cases) {
      const r = await api('POST', `/api/orders/${order.id}/payments`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [order.id]);
    assert.equal(rows[0].n, 0);
    const nf = await api('POST', `/api/orders/${NIL_UUID}/payments`, { type: 'deposit', amount: 1 });
    assert.equal(nf.status, 404, nf.text);
  });

  // RecordPaymentSchema: z.number().positive() has no upper bound
  // (orders.controller.js:26); payments.amount is NUMERIC(12,2) → overflow → 500.
  test('absurdly large amount returns 400, not 500', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const r = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 1e12 });
    assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
  });

  // JSON 1e400 parses to Infinity, which zod 3 z.number().positive() accepts.
  test('non-finite amount (1e400 → Infinity) returns 400, not 500', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const r = await api('POST', `/api/orders/${order.id}/payments`, '{"type":"deposit","amount":1e400}', { raw: true });
    assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
  });

  // 0.001 passes .positive() but NUMERIC(12,2) rounds it to 0.00, storing a
  // zero-value payment that still flips payment_status to deposit_paid.
  test('sub-cent amount is rejected instead of being stored as R0.00 and marking the deposit paid', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    const r = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 0.001 });
    const g = await api('GET', `/api/orders/${order.id}`);
    assert.ok(r.status === 400 || Number(r.json?.payment?.amount) > 0, `stored amount ${r.json?.payment?.amount}`);
    assert.notEqual(g.json.order.payment_status, 'deposit_paid', 'a R0.00 payment must not mark the deposit paid');
  });

  // orders.service.js recordPayment (~line 258): newStatus for type 'balance'
  // is hard-coded to 'deposit_paid'; balance_amount is never recomputed.
  test('paying the outstanding balance marks the order paid_in_full and zeroes the balance', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await db.query(`UPDATE orders SET deposit_amount=600, balance_amount=400 WHERE id=$1`, [order.id]);
    const d = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 600 });
    assert.equal(d.status, 201, d.text);
    const b = await api('POST', `/api/orders/${order.id}/payments`, { type: 'balance', amount: 400 });
    assert.equal(b.status, 201, b.text);
    const g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(g.json.order.payment_status, 'paid_in_full');
    assert.equal(Number(g.json.order.balance_amount), 0);
  });

  // No check of amount against deposit_amount + balance_amount anywhere in
  // orders.service.js recordPayment; a later 'deposit' also downgrades paid_in_full.
  test('payment exceeding the order total is rejected (overpayment)', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await db.query(`UPDATE orders SET deposit_amount=600, balance_amount=400 WHERE id=$1`, [order.id]);
    const f = await api('POST', `/api/orders/${order.id}/payments`, { type: 'full', amount: 1000 });
    assert.equal(f.status, 201, f.text);
    const over = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 500 });
    const g = await api('GET', `/api/orders/${order.id}`);
    assert.equal(over.status, 400, `overpayment accepted: ${over.status}; status now ${g.json.order.payment_status}`);
    assert.equal(g.json.order.payment_status, 'paid_in_full');
  });

  // README: "Record a deposit/balance/full payment → notifies client".
  // orders.service.js recordPayment never calls sendTextMessage (the notifying
  // implementation in payments.service.js is dead code with wrong column names).
  test('recording a payment notifies the client on WhatsApp', async () => {
    const client = await makeClient();
    const order = await makeOrder(client.id);
    await env.waitForJobs(); env.clearFakeCalls();
    const r = await api('POST', `/api/orders/${order.id}/payments`, { type: 'deposit', amount: 250 });
    assert.equal(r.status, 201, r.text);
    await settle();
    const texts = waTextsTo(client.whatsapp_number);
    assert.ok(texts.some((t) => /deposit|payment/i.test(t)), `no payment notification: ${JSON.stringify(texts)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('convert from quotation', () => {
  test('accepted quotation converts once, with 60/40 split and deposit WhatsApp; non-accepted is 400', async () => {
    const client = await makeClient();
    const ref = `BRQ-Q-T${Date.now()}`.slice(0, 30);
    const items = [{ name: 'Polo shirt', quantity: 10, unitPrice: 100, lineTotal: 1000 }];
    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat, total)
       VALUES ($1,$2,'accepted',$3,1000,150,1150) RETURNING id`, [ref, client.id, JSON.stringify(items)]);
    await env.waitForJobs(); env.clearFakeCalls();
    const r = await api('POST', `/api/orders/convert-from-quotation/${q.id}`, { poNumber: 'PO-77' });
    assert.equal(r.status, 201, r.text);
    const o = r.json.order;
    assert.equal(o.quotation_id, q.id);
    assert.equal(Number(o.deposit_amount), 690);
    assert.equal(Number(o.balance_amount), 460);
    assert.equal(o.payment_status, 'unpaid');
    await settle();
    const texts = waTextsTo(client.whatsapp_number);
    assert.ok(texts.some((t) => t.includes(`Ref: ${o.reference}`) && t.includes('690.00')), JSON.stringify(texts));

    const again = await api('POST', `/api/orders/convert-from-quotation/${q.id}`, {});
    assert.equal(again.status, 409, again.text);

    const { rows: [d] } = await db.query(
      `INSERT INTO quotations (reference, client_id, status, total) VALUES ($1,$2,'draft',10) RETURNING id`,
      [`${ref}D`.slice(0, 30), client.id]);
    const draft = await api('POST', `/api/orders/convert-from-quotation/${d.id}`, {});
    assert.equal(draft.status, 400, draft.text);
    const nf = await api('POST', `/api/orders/convert-from-quotation/${NIL_UUID}`, {});
    assert.equal(nf.status, 404, nf.text);
  });
});

test('request budget stays under the API rate limit', () => {
  assert.ok(requestCount < 190, `used ${requestCount} requests`);
});
