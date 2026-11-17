/**
 * Black-box: the job lifecycle over HTTP — stage guards (deposit / proof /
 * balance / hold) with friendly 409 codes, manager overrides (permission,
 * reason, history), legacy stages, the `lifecycle` object (state, flags,
 * nextActions per state and role), quotation mark accepted / declined /
 * revise / resend, tickets (resolution note, client notified, assignee clear,
 * order link) and the bot's "accept" rule.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlackbox, item, cents } from '../helpers/blackbox.js';

let bb;
before(async () => { bb = await startBlackbox(); }, { timeout: 240000 });
after(async () => { await bb?.stop(); });

const keysOf = (lc) => lc.nextActions.map((a) => a.key);
const action = (lc, key) => lc.nextActions.find((a) => a.key === key);
const orderDetail = async (id, token = bb.admin.token) => bb.ok(bb.api('GET', `/api/orders/${id}`, { token }));

// ═════════════════════════════════════════════════════════════════════════════
describe('stage guards', () => {
  test('unpaid order: start production → 409 DEPOSIT_REQUIRED (overridable); after the deposit it advances', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const r = await bb.advance(o.id);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'DEPOSIT_REQUIRED');
    assert.equal(r.json.overridable, true);
    assert.deepEqual(r.json.guards, ['DEPOSIT_REQUIRED']);
    assert.match(r.json.error, /deposit/i);
    assert.equal((await orderDetail(o.id)).order.stage, 'deposit_pending');

    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    const ok = await bb.advance(o.id, { estimatedCompletion: '2030-01-15' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.from, ok.json.to, ok.json.overridden], ['deposit_pending', 'in_production', []]);
  });

  test('ready → completed while the balance is owed → 409 BALANCE_DUE; paying the balance unblocks it', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    assert.equal((await bb.advance(o.id)).status, 200);
    assert.equal((await bb.advance(o.id, { deliveryType: 'delivery', trackingNumber: 'TRK-1' })).status, 200);
    assert.equal((await orderDetail(o.id)).order.delivery_type, 'delivery');
    const blocked = await bb.advance(o.id);
    assert.equal(blocked.status, 409, blocked.text);
    assert.deepEqual([blocked.json.code, blocked.json.overridable], ['BALANCE_DUE', true]);
    await bb.pay(o.id, 'balance', Number(o.balance_amount));
    const done = await bb.advance(o.id);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.to, 'completed');
  });

  test('DAT-1: a repeated "Start production" (stale tab / retried request) is refused 409 STALE — no stage skipped, client told once', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    await bb.pay(o.id, 'balance', Number(o.balance_amount)); // paid in full: nothing else would stop ready → completed
    const first = await bb.advance(o.id, { expect: 'in_production' });
    assert.equal(first.status, 200, first.text);
    await bb.env.waitForJobs();
    const sentAfterFirst = bb.outbound(client.whatsapp_number).length;

    const again = await bb.advance(o.id, { expect: 'in_production' });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, 'STALE');
    assert.equal((await orderDetail(o.id)).order.stage, 'in_production', 'not moved to ready');
    await bb.env.waitForJobs();
    assert.equal(bb.outbound(client.whatsapp_number).length, sentAfterFirst, 'no second stage message');

    // Double "Mark ready" on a paid order must not mark it collected.
    assert.equal((await bb.advance(o.id, { expect: 'ready' })).status, 200);
    const twice = await bb.advance(o.id, { expect: 'ready' });
    assert.deepEqual([twice.status, twice.json.code], [409, 'STALE']);
    assert.equal((await orderDetail(o.id)).order.stage, 'ready');
  });

  test('DAT-1: a stale expect with a payment attached saves nothing (payment rolled back with the advance)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    const r = await bb.advance(o.id, { expect: 'completed', payment: { amount: 1, type: 'balance' } });
    assert.deepEqual([r.status, r.json.code], [409, 'STALE']);
    const { rows } = await bb.db.query('SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1', [o.id]);
    assert.equal(rows[0].n, 1, 'only the deposit');
  });

  test('FIN-1: "Record deposit + start production" submitted twice with one key → one payment, one advance, 200 replayed', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const body = { type: 'deposit', amount: Number(o.deposit_amount), startProduction: {}, idempotencyKey: `k-${o.id}` };
    const first = await bb.api('POST', `/api/orders/${o.id}/payments`, { token: bb.consultant.token, body });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.json.advanced.to, 'in_production');
    const again = await bb.api('POST', `/api/orders/${o.id}/payments`, { token: bb.consultant.token, body });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.payment.id, first.json.payment.id);
    const { rows } = await bb.db.query('SELECT recorded_by FROM payments WHERE order_id = $1', [o.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recorded_by, bb.consultant.id, 'who recorded it is stored');
    assert.equal((await orderDetail(o.id)).order.stage, 'in_production', 'advanced once, not twice');
  });

  test('DAT-1: expect must be a real stage (400)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    assert.equal((await bb.advance(o.id, { expect: 'shipped' })).status, 400);
  });

  test('a proof out with the client blocks production → 409 PROOF_PENDING', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/p.png' } }));
    const r = await bb.advance(o.id);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'PROOF_PENDING');
    assert.equal(r.json.overridable, true);
  });

  test('consultant override → 403; manager with a short reason → 400; nothing moves', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const c = await bb.advance(o.id, { override: { reason: 'client paid in cash' } }, bb.consultant.token);
    assert.equal(c.status, 403, c.text);
    assert.equal(c.json.code, 'OVERRIDE_FORBIDDEN');
    const m = await bb.advance(o.id, { override: { reason: 'ok' } }, bb.manager.token);
    assert.equal(m.status, 400, m.text);
    assert.equal(m.json.code, 'OVERRIDE_REASON_REQUIRED');
    assert.equal((await orderDetail(o.id)).order.stage, 'deposit_pending');
  });

  test('manager override succeeds and is recorded in the stage history (who, why, which guards, from)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/p.png' } }));
    const r = await bb.advance(o.id, { override: { reason: 'Account client — pays on 30-day terms' }, notes: 'rush job' }, bb.manager.token);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.overridden, ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
    const { history } = await orderDetail(o.id);
    const h = history.at(-1);
    assert.deepEqual(
      [h.stage, h.from_stage, h.changed_by, h.changed_by_name, h.notes, h.override_reason, h.overridden_guards],
      ['in_production', 'deposit_pending', bb.manager.id, 'Mandla Manager', 'rush job', 'Account client — pays on 30-day terms', ['PROOF_PENDING', 'DEPOSIT_REQUIRED']]);
  });

  test('admin can override the balance guard too', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.db.query(`UPDATE orders SET stage = 'ready', payment_status = 'deposit_paid' WHERE id = $1`, [o.id]);
    const r = await bb.advance(o.id, { override: { reason: 'Balance settled in store' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.overridden, ['BALANCE_DUE']);
  });

  test('on hold blocks every move, even a manager override (409 HOLD, not overridable)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    await bb.ok(bb.api('PATCH', `/api/orders/${o.id}/hold`, { token: bb.admin.token, body: { isOnHold: true, holdReason: 'awaiting_artwork' } }));
    for (const body of [{}, { override: { reason: 'please just move it' } }]) {
      const r = await bb.advance(o.id, body, bb.manager.token);
      assert.equal(r.status, 409, r.text);
      assert.deepEqual([r.json.code, r.json.overridable], ['HOLD', false]);
    }
    const { lifecycle } = await orderDetail(o.id, bb.manager.token);
    assert.ok(lifecycle.flags.includes('ON_HOLD'));
    assert.equal(lifecycle.nextActions[0].key, 'release_hold');
    assert.equal(action(lifecycle, 'start_production').code, 'HOLD');
    assert.equal(action(lifecycle, 'start_production').overrideAllowed, false);
  });

  test("a legacy-stage order ('manufacturing') advances to ready", async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    await bb.db.query(`UPDATE orders SET stage = 'manufacturing' WHERE id = $1`, [o.id]);
    const before = await orderDetail(o.id);
    assert.equal(before.lifecycle.state, 'IN_PRODUCTION');
    const r = await bb.advance(o.id);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.from, r.json.to], ['manufacturing', 'ready']);
  });

  test('override field validation: non-object override → 400', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const r = await bb.advance(o.id, { override: 'yes please' }, bb.manager.token);
    assert.equal(r.status, 400, r.text);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('lifecycle object: nextActions per state and role', () => {
  test('quotation states: PRICING → QUOTED (one-step "client accepted — create order"; no separate PO step)', async () => {
    const client = await bb.makeClient();
    const created = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.consultant.token, body: { clientId: client.id, notes: 'Needs 20 polos' } }), 201);
    assert.equal(created.quotation.status, 'draft');
    assert.equal(created.quotation.assigned_staff_id, bb.consultant.id, 'assigned to the creator');
    assert.equal(created.lifecycle.state, 'PRICING');
    assert.deepEqual(keysOf(created.lifecycle), ['price_quote', 'mark_declined']);
    const id = created.quotation.id;

    await bb.ok(bb.api('POST', `/api/quotations/${id}/approve`, { token: bb.consultant.token, body: { lineItems: [item('Polo', 20, 120)] } }));
    const asConsultant = await bb.ok(bb.api('GET', `/api/quotations/${id}`, { token: bb.consultant.token }));
    assert.equal(asConsultant.lifecycle.state, 'QUOTED');
    // Changed in UX round 2: accepting and creating the order is one step, and the
    // PO number is entered there (no locked "Record purchase order" for consultants).
    assert.deepEqual(keysOf(asConsultant.lifecycle), ['accept_and_order', 'resend_quote', 'mark_declined', 'revise_quote']);
    assert.equal(action(asConsultant.lifecycle, 'accept_and_order').primary, true);
    const asManager = await bb.ok(bb.api('GET', `/api/quotations/${id}`, { token: bb.manager.token }));
    assert.deepEqual(keysOf(asManager.lifecycle), keysOf(asConsultant.lifecycle));
  });

  test('order states: AWAITING_DEPOSIT → READY_TO_PRODUCE → IN_PRODUCTION → READY → COMPLETED; override per role', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    let c = await orderDetail(o.id, bb.consultant.token);
    let m = await orderDetail(o.id, bb.manager.token);
    assert.equal(c.lifecycle.state, 'AWAITING_DEPOSIT');
    assert.equal(c.lifecycle.nextActions[0].key, 'record_deposit');
    assert.equal(cents(c.lifecycle.nextActions[0].inputs.find((i) => i.name === 'amount').default), cents(o.deposit_amount));
    assert.equal(action(c.lifecycle, 'start_production').enabled, false);
    assert.equal(action(c.lifecycle, 'start_production').code, 'DEPOSIT_REQUIRED');
    assert.equal(action(c.lifecycle, 'start_production').overrideAllowed, false);
    assert.equal(action(m.lifecycle, 'start_production').overrideAllowed, true);

    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    c = await orderDetail(o.id, bb.consultant.token);
    assert.equal(c.lifecycle.state, 'READY_TO_PRODUCE');
    assert.equal(action(c.lifecycle, 'start_production').enabled, true);
    assert.equal(action(c.lifecycle, 'start_production').primary, true);

    await bb.advance(o.id);
    c = await orderDetail(o.id, bb.consultant.token);
    assert.equal(c.lifecycle.state, 'IN_PRODUCTION');
    assert.deepEqual(keysOf(c.lifecycle), ['mark_ready', 'record_balance']);

    await bb.advance(o.id);
    c = await orderDetail(o.id, bb.consultant.token);
    assert.equal(c.lifecycle.state, 'READY');
    // Changed in UX round 2: money owed at collection is BALANCE_DUE (not OVERDUE), and
    // "Mark collected" takes the balance in the same step.
    assert.ok(c.lifecycle.flags.includes('BALANCE_DUE'), 'balance owed once ready');
    assert.ok(!c.lifecycle.flags.includes('OVERDUE'));
    assert.equal(c.lifecycle.nextActions[0].key, 'mark_collected');
    assert.equal(c.lifecycle.nextActions[0].enabled, true);
    assert.equal(cents(action(c.lifecycle, 'mark_collected').inputs.find((i) => i.name === 'balanceAmount').default), cents(o.balance_amount));

    await bb.pay(o.id, 'balance', Number(o.balance_amount));
    c = await orderDetail(o.id, bb.consultant.token);
    assert.deepEqual(keysOf(c.lifecycle), ['mark_collected']);
    await bb.advance(o.id);
    c = await orderDetail(o.id, bb.consultant.token);
    assert.equal(c.lifecycle.state, 'COMPLETED');
    assert.deepEqual(keysOf(c.lifecycle), ['open_ticket']);
  });

  test('list rows carry lifecycle_state (orders and quotations)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const orders = await bb.ok(bb.api('GET', '/api/orders?limit=200', { token: bb.admin.token }));
    assert.deepEqual(Object.keys(orders).sort(), ['items', 'limit', 'orders', 'page', 'total']);
    assert.equal(orders.items.find((x) => x.id === o.id).lifecycle_state, 'AWAITING_DEPOSIT');
    const quotes = await bb.ok(bb.api('GET', `/api/quotations?clientId=${client.id}`, { token: bb.admin.token }));
    assert.deepEqual(quotes.items, quotes.quotations);
    assert.equal(quotes.items[0].lifecycle_state, 'AWAITING_DEPOSIT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('quotation actions: mark accepted / declined / revise / resend', () => {
  test('mark accepted (sent → accepted) returns the lifecycle; a second accept is 409', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client);
    const r = await bb.ok(bb.api('PATCH', `/api/quotations/${q.id}/status`, { token: bb.consultant.token, body: { status: 'accepted' } }));
    assert.equal(r.quotation.status, 'accepted');
    assert.equal(r.lifecycle.state, 'ACCEPTED');
    assert.equal(r.lifecycle.nextActions[0].key, 'create_order');
    const again = await bb.api('PATCH', `/api/quotations/${q.id}/status`, { token: bb.consultant.token, body: { status: 'accepted' } });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, 'INVALID_TRANSITION');
  });

  test('mark declined, then revise (→ draft, pricing again)', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client);
    const d = await bb.ok(bb.api('PATCH', `/api/quotations/${q.id}/status`, { token: bb.admin.token, body: { status: 'rejected' } }));
    assert.equal(d.lifecycle.state, 'DECLINED');
    assert.deepEqual(keysOf(d.lifecycle), ['revise_quote']);
    const rev = await bb.ok(bb.api('PATCH', `/api/quotations/${q.id}/status`, { token: bb.admin.token, body: { status: 'draft' } }));
    assert.equal(rev.quotation.status, 'draft');
    assert.equal(rev.lifecycle.state, 'PRICING');
    // …and it can be priced and sent again
    const again = await bb.api('POST', `/api/quotations/${q.id}/approve`, { token: bb.admin.token, body: { lineItems: [item('Golf shirt', 12, 100)] } });
    assert.equal(again.status, 200, again.text);
  });

  test('revise is refused once an order exists (409 ORDER_EXISTS); expired quote cannot be accepted (409 QUOTE_EXPIRED)', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const r = await bb.api('PATCH', `/api/quotations/${o.quotation_id}/status`, { token: bb.admin.token, body: { status: 'draft' } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'ORDER_EXISTS');

    const q = await bb.sentQuote(client);
    await bb.db.query(`UPDATE quotations SET valid_until = '2020-01-01' WHERE id = $1`, [q.id]);
    const e = await bb.api('PATCH', `/api/quotations/${q.id}/status`, { token: bb.admin.token, body: { status: 'accepted' } });
    assert.equal(e.status, 409, e.text);
    assert.equal(e.json.code, 'QUOTE_EXPIRED');
    const lc = await bb.ok(bb.api('GET', `/api/quotations/${q.id}`, { token: bb.admin.token }));
    assert.equal(lc.lifecycle.state, 'EXPIRED');
    assert.deepEqual(keysOf(lc.lifecycle), ['revise_quote']);
  });

  test('approve: caption tells the client to reply *accept*; a chat waiting for a consultant goes back to the bot', async () => {
    const phone = await bb.registeredPhone('Waiting Wendy');
    const client = await bb.clientOf(phone);
    await bb.db.query(`UPDATE conversations SET state = 'awaiting_consultant' WHERE client_id = $1`, [client.id]);
    await bb.env.waitForJobs();
    bb.env.clearFakeCalls();
    const q = await bb.sentQuote(client);
    assert.equal((await bb.convoOf(phone)).state, 'main_menu');
    await bb.env.waitForJobs();
    const docs = bb.outbound(phone).filter((c) => c.body.type === 'document');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].body.document.filename, `${q.reference}.pdf`);
    assert.match(docs[0].body.document.caption, /Reply \*accept\* to go ahead, \*changes\* to request edits, or \*9\* to talk to us\. Valid until /);
    const { rows } = await bb.db.query(`SELECT body FROM messages WHERE client_id = $1 AND direction = 'outbound' AND job_id IS NOT NULL`, [client.id]);
    assert.ok(rows.some((m) => m.body.startsWith(`[document: ${q.reference}.pdf]`)), 'PDF recorded in the inbox');
  });

  test('a consultant actively chatting keeps the conversation after approve', async () => {
    const phone = await bb.registeredPhone('Chatting Chad');
    const client = await bb.clientOf(phone);
    await bb.db.query(`UPDATE conversations SET state = 'consultant_active' WHERE client_id = $1`, [client.id]);
    await bb.sentQuote(client);
    assert.equal((await bb.convoOf(phone)).state, 'consultant_active');
  });

  test('resend: 202, exactly one more PDF after the queue drains; draft → 409; consultant may resend', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client);
    await bb.env.waitForJobs();
    bb.env.clearFakeCalls();
    const r = await bb.api('POST', `/api/quotations/${q.id}/resend`, { token: bb.consultant.token });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.queued, true);
    await bb.env.waitForJobs();
    const docs = bb.outbound(client.whatsapp_number).filter((c) => c.body.type === 'document');
    assert.equal(docs.length, 1);

    const draft = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id } }), 201);
    const d = await bb.api('POST', `/api/quotations/${draft.quotation.id}/resend`, { token: bb.admin.token });
    assert.equal(d.status, 409, d.text);
    assert.equal(d.json.code, 'QUOTE_NOT_SENT');
    assert.equal((await bb.api('POST', '/api/quotations/00000000-0000-4000-8000-000000000000/resend', { token: bb.admin.token })).status, 404);
  });

  test('POST /quotations validation: unknown client 400, conversation of another client 400, bad body 400', async () => {
    const a = await bb.makeClient();
    const b = await bb.makeClient();
    const { rows: [cv] } = await bb.db.query(`INSERT INTO conversations (client_id) VALUES ($1) RETURNING id`, [b.id]);
    const cases = [
      { clientId: '00000000-0000-4000-8000-000000000000' },
      { clientId: a.id, conversationId: cv.id },
      { clientId: 'nope' },
      { clientId: a.id, lineItems: [{ name: '', quantity: 1, unitPrice: 1 }] },
    ];
    for (const body of cases) {
      const r = await bb.api('POST', '/api/quotations', { token: bb.admin.token, body });
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${r.text}`);
    }
    const okWithChat = await bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: b.id, conversationId: cv.id, lineItems: [item('Cap', 5, 50)] } });
    assert.equal(okWithChat.status, 201, okWithChat.text);
    assert.equal(okWithChat.json.quotation.conversation_id, cv.id);
    assert.equal(cents(okWithChat.json.quotation.total), cents(287.5));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('tickets', () => {
  test('resolve with a note → client notified on WhatsApp; ticket ↔ order link visible; assignee can be cleared', async () => {
    const client = await bb.makeClient();
    const o = await bb.order(client);
    const created = await bb.ok(bb.api('POST', '/api/tickets', {
      token: bb.consultant.token, body: { clientId: client.id, orderId: o.id, category: 'defective', description: 'Two shirts have split seams' },
    }), 201);
    const t = created.ticket;
    assert.deepEqual([t.order_reference, t.quotation_id, t.assigned_staff_id], [o.reference, o.quotation_id, bb.consultant.id]);

    const cleared = await bb.ok(bb.api('PATCH', `/api/tickets/${t.id}`, { token: bb.admin.token, body: { assignedStaffId: null } }));
    assert.equal(cleared.ticket.assigned_staff_id, null);

    await bb.env.waitForJobs();
    bb.env.clearFakeCalls();
    const resolved = await bb.ok(bb.api('PATCH', `/api/tickets/${t.id}`, {
      token: bb.admin.token, body: { status: 'resolved', resolutionNote: 'Replacement shirts couriered today.' },
    }));
    assert.equal(resolved.ticket.status, 'resolved');
    assert.equal(resolved.ticket.resolution_note, 'Replacement shirts couriered today.');
    await bb.env.waitForJobs();
    const texts = bb.textsTo(client.whatsapp_number);
    assert.equal(texts.length, 1, JSON.stringify(texts));
    assert.match(texts[0], new RegExp(`resolved\\* — Order ${o.reference}`));
    assert.ok(texts[0].includes('Replacement shirts couriered today.'));

    const g = await bb.ok(bb.api('GET', `/api/tickets/${t.id}`, { token: bb.admin.token }));
    assert.deepEqual([g.ticket.order_reference, g.ticket.quotation_id], [o.reference, o.quotation_id]);

    // closing a resolved ticket does not notify again; closed → resolved is refused
    await bb.ok(bb.api('PATCH', `/api/tickets/${t.id}`, { token: bb.admin.token, body: { status: 'closed' } }));
    const bad = await bb.api('PATCH', `/api/tickets/${t.id}`, { token: bb.admin.token, body: { status: 'resolved' } });
    assert.equal(bad.status, 409, bad.text);
    assert.equal(bad.json.code, 'TICKET_TRANSITION');
    await bb.env.waitForJobs();
    assert.equal(bb.textsTo(client.whatsapp_number).length, 1);
  });

  test('POST /tickets validation and the paged list envelope', async () => {
    const client = await bb.makeClient();
    const other = await bb.makeClient();
    const o = await bb.order(other);
    const bad = await bb.api('POST', '/api/tickets', { token: bb.admin.token, body: { clientId: client.id, orderId: o.id, category: 'other', description: 'Wrong client order' } });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await bb.api('POST', '/api/tickets', { token: bb.admin.token, body: { clientId: client.id, category: 'bogus', description: 'xxxxx' } })).status, 400);
    const list = await bb.ok(bb.api('GET', `/api/tickets?clientId=${other.id}`, { token: bb.admin.token }));
    assert.deepEqual(Object.keys(list).sort(), ['items', 'limit', 'page', 'tickets', 'total']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('bot: accept rule and ticket ↔ order linking', () => {
  test('"accept" works while the chat waits for a consultant; "accept BRQ-Q-…" picks that quote', async () => {
    const phone = await bb.registeredPhone('Accepting Anna');
    const client = await bb.clientOf(phone);
    const q1 = await bb.sentQuote(client);
    const q2 = await bb.sentQuote(client);
    await bb.env.waitForJobs();
    await bb.db.query(`UPDATE conversations SET state = 'awaiting_consultant' WHERE client_id = $1 AND is_open`, [client.id]);

    let r = await bb.sendInbound(phone, `accept ${q1.reference.toLowerCase()}`);
    assert.ok(r.some((x) => x.includes(`Quotation Accepted — Ref: ${q1.reference}`)), r.join('|'));
    assert.equal((await bb.db.query('SELECT status FROM quotations WHERE id = $1', [q1.id])).rows[0].status, 'accepted');
    assert.equal((await bb.db.query('SELECT status FROM quotations WHERE id = $1', [q2.id])).rows[0].status, 'sent');
    assert.equal((await bb.convoOf(phone)).state, 'awaiting_consultant', 'still waiting for the consultant');

    r = await bb.sendInbound(phone, 'Accept');
    assert.ok(r.some((x) => x.includes(`Quotation Accepted — Ref: ${q2.reference}`)), r.join('|'));
    r = await bb.sendInbound(phone, 'accept');
    assert.ok(r.some((x) => x.includes("couldn't find an open quotation to accept")), r.join('|'));
  });

  test('owner decision 1: "accept" also works while a consultant is actively chatting — accepted, no order, chat stays with the consultant', async () => {
    const phone = await bb.registeredPhone('Busy Ben');
    const client = await bb.clientOf(phone);
    const q = await bb.sentQuote(client);
    await bb.env.waitForJobs();
    await bb.db.query(`UPDATE conversations SET state = 'consultant_active' WHERE client_id = $1 AND is_open`, [client.id]);
    const r = await bb.sendInbound(phone, 'accept');
    assert.ok(r.some((x) => x.includes(`Quotation Accepted — Ref: ${q.reference}`) && x.includes('Your consultant will confirm your order')), r.join('|'));
    assert.equal((await bb.db.query('SELECT status FROM quotations WHERE id = $1', [q.id])).rows[0].status, 'accepted');
    assert.equal((await bb.db.query('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id = $1', [q.id])).rows[0].n, 0);
    assert.equal((await bb.convoOf(phone)).state, 'consultant_active');
  });

  test('an expired quote cannot be accepted by the client — a refresh at today\'s prices is offered instead', async () => {
    const phone = await bb.registeredPhone('Late Lerato');
    const client = await bb.clientOf(phone);
    const q = await bb.sentQuote(client);
    await bb.db.query(`UPDATE quotations SET valid_until = '2020-01-01' WHERE id = $1`, [q.id]);
    const r = await bb.sendInbound(phone, `accept ${q.reference}`);
    assert.ok(r.some((x) => x.includes(`Quote *${q.reference}* expired on 1 Jan 2020`) && x.includes('Reply *1*')), r.join('|'));
    assert.equal((await bb.db.query('SELECT status FROM quotations WHERE id = $1', [q.id])).rows[0].status, 'sent');
  });

  test("a complaint links the ticket to the quoted order reference, else to the client's single active order", async () => {
    const phone = await bb.registeredPhone('Ticket Thabo');
    const client = await bb.clientOf(phone);
    const first = await bb.order(client);
    const second = await bb.order(client);
    await bb.env.waitForJobs();

    // A detailed first message is logged at once (category inferred from the words)
    await bb.sendInbound(phone, `My shirts are defective — order ${first.reference}: five of the shirts have split seams on the shoulder`);
    let { rows } = await bb.db.query('SELECT order_id FROM tickets WHERE client_id = $1 ORDER BY created_at', [client.id]);
    assert.equal(rows.at(-1).order_id, first.id, 'quoted reference wins');

    // Two active orders and no reference → ambiguous → not linked. Complete one → the other is the single active one.
    await bb.db.query(`UPDATE orders SET stage = 'completed' WHERE id = $1`, [first.id]);
    await bb.db.query(`UPDATE conversations SET state = 'main_menu' WHERE client_id = $1 AND is_open`, [client.id]);
    await bb.sendInbound(phone, 'I have a complaint');
    await bb.sendInbound(phone, '1');
    await bb.sendInbound(phone, 'We received small instead of large sizes for all of the jackets');
    ({ rows } = await bb.db.query('SELECT order_id FROM tickets WHERE client_id = $1 ORDER BY created_at', [client.id]));
    assert.equal(rows.at(-1).order_id, second.id, 'single active order');
  });
});
