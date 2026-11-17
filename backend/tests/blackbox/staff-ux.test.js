/**
 * Black-box: staff dashboard round 2 — "Client accepted — create order" in one
 * call, mark collected with the balance taken at the counter, "start production
 * now" riding on the deposit / design approval, account clients (no deposit
 * guard; balance guard still applies; permission), legacy quote-less orders in
 * Jobs (migration 0009 backfill; board counts), BALANCE_DUE vs OVERDUE, every
 * blocking guard listed on a 409, quotation autosave (PUT, drafts only), draft
 * PDF preview (staff only), one-click primary actions on the jobs list,
 * resolving tickets from any job state, quotes started from a chat, the
 * client's chat / money summary and who sent inbox messages.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBlackbox, item, rnd } from '../helpers/blackbox.js';
import { BACKEND } from '../helpers/env.js';

let bb;
before(async () => { bb = await startBlackbox(); }, { timeout: 240000 });
after(async () => { await bb?.stop(); });

const job = (qid, token = bb.admin.token) => bb.ok(bb.api('GET', `/api/jobs/${qid}`, { token }));
const act = (lc, key) => lc.nextActions.find((a) => a.key === key);
const orderRow = async (id) => (await bb.db.query('SELECT o.*, (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id = o.id) AS paid FROM orders o WHERE o.id = $1', [id])).rows[0];

/** An order at "ready" with only the deposit paid (outstanding 460 of 1150). */
async function readyOrder(client) {
  const o = await bb.order(client ?? await bb.makeClient());
  await bb.pay(o.id, 'deposit', 690);
  await bb.ok(bb.advance(o.id));
  await bb.ok(bb.advance(o.id));
  return o;
}

// ═════════════════════════════════════════════════════════════════════════════
describe('Client accepted — create order (one call)', () => {
  test('a sent quote: accept + convert in one call; owner = the actor; PO number → PO log + history', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client, { token: bb.admin.token });
    const before = await job(q.id, bb.consultant.token);
    assert.equal(before.lifecycle.state, 'QUOTED');
    const primary = before.lifecycle.nextActions.find((a) => a.primary);
    assert.deepEqual([primary.key, primary.label], ['accept_and_order', 'Client accepted — create order']);
    assert.ok(!before.lifecycle.nextActions.some((a) => a.key === 'record_po'), 'no separate PO step');

    const r = await bb.ok(bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, {
      token: bb.consultant.token, body: { accept: true, poNumber: 'PO-UX-1' },
    }), 201);
    assert.equal(r.order.po_number, 'PO-UX-1');
    assert.equal(r.order.assigned_staff_id, bb.consultant.id, 'the order belongs to whoever created it');
    const after = await job(q.id);
    assert.equal(after.quotation.status, 'accepted');
    assert.equal(after.lifecycle.state, 'AWAITING_DEPOSIT');
    assert.equal(after.purchaseOrders.length, 1);
    assert.deepEqual([after.purchaseOrders[0].po_number, after.purchaseOrders[0].status, after.purchaseOrders[0].order_id], ['PO-UX-1', 'valid', r.order.id]);
    assert.ok(after.history.some((e) => e.type === 'po.recorded'));
    assert.ok(after.history.some((e) => e.type === 'quotation.accepted'));
    const log = await bb.ok(bb.api('GET', '/api/purchase-orders', { token: bb.admin.token }));
    assert.ok(log.items.some((po) => po.po_number === 'PO-UX-1' && po.quotation_id === q.id));
  });

  test('without accept a sent quote is refused (400 QUOTE_NOT_ACCEPTED); a draft cannot be accepted', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client);
    const r = await bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: {} });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'QUOTE_NOT_ACCEPTED');
    const { quotation: draft } = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id } }), 201);
    const d = await bb.api('POST', `/api/orders/convert-from-quotation/${draft.id}`, { token: bb.admin.token, body: { accept: true } });
    assert.equal(d.status, 400, d.text);
    const twice = await bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: { accept: true } });
    assert.equal(twice.status, 201, twice.text);
    const again = await bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: { accept: true } });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'ORDER_EXISTS');
  });

  test('an accepted quote (client said yes on WhatsApp): "Create order" with only an optional PO number', async () => {
    const client = await bb.makeClient();
    const q = await bb.acceptedQuote(client);
    const { lifecycle } = await job(q.id);
    const create = act(lifecycle, 'create_order');
    assert.equal(create.primary, true);
    assert.deepEqual(create.inputs.map((i) => [i.name, i.required, i.label]), [['poNumber', false, 'Purchase order number']]);
  });

  test('sending a quote claims an unowned quote for the sender', async () => {
    const client = await bb.makeClient();
    const { rows: [q] } = await bb.db.query(
      `INSERT INTO quotations (reference, client_id, status, line_items) VALUES ($1, $2, 'draft', '[]') RETURNING id`, [`BRQ-Q-UX-${rnd()}`, client.id]);
    await bb.ok(bb.api('POST', `/api/quotations/${q.id}/approve`, { token: bb.consultant.token, body: { lineItems: [item('Polo', 5, 100)] } }));
    const { rows: [after] } = await bb.db.query('SELECT assigned_staff_id, claimed_at FROM quotations WHERE id = $1', [q.id]);
    assert.equal(after.assigned_staff_id, bb.consultant.id);
    assert.ok(after.claimed_at);
    // An owned quote keeps its owner.
    const owned = await bb.sentQuote(await bb.makeClient(), { token: bb.manager.token });
    assert.equal((await bb.db.query('SELECT assigned_staff_id FROM quotations WHERE id = $1', [owned.id])).rows[0].assigned_staff_id, bb.manager.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Mark collected with the balance', () => {
  test('READY: "Mark collected" carries the outstanding balance; recording it and completing is one call', async () => {
    const o = await readyOrder();
    const { lifecycle } = await job(o.quotation_id);
    assert.deepEqual(lifecycle.flags.filter((f) => ['BALANCE_DUE', 'OVERDUE'].includes(f)), ['BALANCE_DUE']);
    const collect = act(lifecycle, 'mark_collected');
    assert.equal(collect.primary, true);
    assert.equal(collect.enabled, true);
    assert.equal(collect.inputs.find((i) => i.name === 'balanceAmount').default, 460);

    const r = await bb.ok(bb.advance(o.id, { payment: { amount: 460 } }));
    assert.deepEqual([r.from, r.to], ['ready', 'completed']);
    assert.equal(Number(r.payment.amount), 460);
    const row = await orderRow(o.id);
    assert.deepEqual([row.stage, row.payment_status, Number(row.paid)], ['completed', 'paid_in_full', 1150]);
  });

  test('part of the balance → 409 BALANCE_DUE and nothing is saved; a manager can skip the check with a reason', async () => {
    const o = await readyOrder();
    const r = await bb.advance(o.id, { payment: { amount: 100 } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'BALANCE_DUE');
    assert.match(r.json.error, /R 360\.00 would still be owed/);
    assert.match(r.json.error, /Nothing was saved/);
    let row = await orderRow(o.id);
    assert.deepEqual([row.stage, Number(row.paid)], ['ready', 690], 'the payment was rolled back');

    const ok = await bb.ok(bb.advance(o.id, { payment: { amount: 100 }, override: { reason: 'Client pays the rest on account' } }, bb.manager.token));
    assert.deepEqual(ok.overridden, ['BALANCE_DUE']);
    row = await orderRow(o.id);
    assert.deepEqual([row.stage, Number(row.paid)], ['completed', 790]);
  });

  test('an overpayment is refused (400) and the order stays ready', async () => {
    const o = await readyOrder();
    const r = await bb.advance(o.id, { payment: { amount: 9999 } });
    assert.equal(r.status, 400, r.text);
    assert.equal((await orderRow(o.id)).stage, 'ready');
  });

  test('delivery orders say "Mark delivered"', async () => {
    const o = await bb.order(await bb.makeClient());
    await bb.pay(o.id, 'full', 1150);
    await bb.ok(bb.advance(o.id));
    await bb.ok(bb.advance(o.id, { deliveryType: 'delivery', trackingNumber: 'TRK1' }));
    const { lifecycle } = await job(o.quotation_id);
    assert.equal(act(lifecycle, 'mark_collected').label, 'Mark delivered');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Start production now', () => {
  test('recording the deposit with startProduction starts production (one transaction)', async () => {
    const o = await bb.order(await bb.makeClient());
    const deposit = act((await job(o.quotation_id)).lifecycle, 'record_deposit');
    assert.ok(deposit.inputs.some((i) => i.name === 'startProduction'));
    const r = await bb.ok(bb.api('POST', `/api/orders/${o.id}/payments`, {
      token: bb.admin.token, body: { type: 'deposit', amount: 690, startProduction: { estimatedCompletion: '2030-03-01' } },
    }), 201);
    assert.equal(r.advanced.to, 'in_production');
    const row = await orderRow(o.id);
    assert.equal(row.stage, 'in_production');
    assert.equal(row.payment_status, 'deposit_paid');
    assert.equal(new Date(row.estimated_completion_date).getFullYear(), 2030);
  });

  test('a deposit too small to start → 409 and nothing saved; without startProduction it is just a payment', async () => {
    const o = await bb.order(await bb.makeClient());
    const r = await bb.api('POST', `/api/orders/${o.id}/payments`, { token: bb.admin.token, body: { type: 'deposit', amount: 100, startProduction: {} } });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'DEPOSIT_REQUIRED');
    assert.equal(Number((await orderRow(o.id)).paid), 0);
    const plain = await bb.ok(bb.api('POST', `/api/orders/${o.id}/payments`, { token: bb.admin.token, body: { type: 'deposit', amount: 100 } }), 201);
    assert.equal(plain.advanced, undefined);
  });

  test('approving the design with startProduction starts production', async () => {
    const o = await bb.order(await bb.makeClient());
    await bb.pay(o.id, 'deposit', 690);
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/p.png' } }));
    const approve = act((await job(o.quotation_id)).lifecycle, 'mark_proof_approved');
    assert.equal(approve.label, 'Approve design');
    assert.ok(approve.inputs.some((i) => i.name === 'startProduction'));
    const r = await bb.ok(bb.api('PATCH', `/api/orders/${o.id}/proof/status`, {
      token: bb.admin.token, body: { status: 'approved', startProduction: { estimatedCompletion: '2030-04-01' } },
    }));
    assert.equal(r.order.stage, 'in_production');
    assert.equal(r.order.proof_status, 'approved');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Account clients', () => {
  test('only admins / managers may set account terms; who and when are kept; meta lists the permission', async () => {
    const client = await bb.makeClient();
    const c = await bb.api('PATCH', `/api/clients/${client.id}/account-terms`, { token: bb.consultant.token, body: { accountTerms: true } });
    assert.equal(c.status, 403);
    const r = await bb.ok(bb.api('PATCH', `/api/clients/${client.id}/account-terms`, { token: bb.manager.token, body: { accountTerms: true } }));
    assert.equal(r.client.account_terms, true);
    assert.equal(r.client.account_terms_set_by, bb.manager.id);
    assert.ok(r.client.account_terms_set_at);
    const detail = await bb.ok(bb.api('GET', `/api/clients/${client.id}`, { token: bb.consultant.token }));
    assert.equal(detail.client.account_terms_set_by_name, 'Mandla Manager');
    assert.equal((await bb.api('PATCH', `/api/clients/${client.id}/account-terms`, { token: bb.manager.token, body: {} })).status, 400);
    assert.ok((await bb.ok(bb.api('GET', '/api/meta', { token: bb.manager.token }))).permissions.includes('client.terms'));
    assert.ok(!(await bb.ok(bb.api('GET', '/api/meta', { token: bb.consultant.token }))).permissions.includes('client.terms'));
  });

  test('no deposit guard: straight to ready to produce and into production; the balance guard still applies', async () => {
    const client = await bb.makeClient();
    await bb.ok(bb.api('PATCH', `/api/clients/${client.id}/account-terms`, { token: bb.admin.token, body: { accountTerms: true } }));
    const o = await bb.order(client);
    const j = await job(o.quotation_id);
    assert.equal(j.lifecycle.state, 'READY_TO_PRODUCE');
    assert.equal(j.client.account_terms, true);
    assert.equal(act(j.lifecycle, 'start_production').enabled, true);
    const board = await bb.ok(bb.api('GET', `/api/jobs?clientId=${client.id}`, { token: bb.admin.token }));
    assert.deepEqual([board.items[0].state, board.items[0].account_terms], ['READY_TO_PRODUCE', true]);

    await bb.ok(bb.advance(o.id, { estimatedCompletion: '2030-05-01' }, bb.consultant.token));
    await bb.ok(bb.advance(o.id, {}, bb.consultant.token));
    const blocked = await bb.advance(o.id, {}, bb.consultant.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'BALANCE_DUE');
    await bb.ok(bb.advance(o.id, { payment: { amount: 1150 } }, bb.consultant.token));
    // Taking the terms away brings the deposit back for new orders.
    await bb.ok(bb.api('PATCH', `/api/clients/${client.id}/account-terms`, { token: bb.admin.token, body: { accountTerms: false } }));
    const o2 = await bb.order(client);
    assert.equal((await job(o2.quotation_id)).lifecycle.state, 'AWAITING_DEPOSIT');
    assert.equal((await bb.advance(o2.id)).json.code, 'DEPOSIT_REQUIRED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Legacy orders in Jobs (migration 0009)', () => {
  test('a quote-less order gets a linked accepted quotation; it shows on the board; counts match; re-running is a no-op', async () => {
    const client = await bb.makeClient({ name: `Legacy ${rnd()}` });
    const ref = `BRQ-O-2025${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const { rows: [o] } = await bb.db.query(
      `INSERT INTO orders (reference, client_id, stage, payment_status, total_amount, deposit_amount, balance_amount, created_at)
       VALUES ($1, $2, 'manufacturing', 'deposit_paid', 1150, 690, 460, now() - interval '200 days') RETURNING *`, [ref, client.id]);
    const { rows: [bare] } = await bb.db.query(
      `INSERT INTO orders (reference, client_id, stage, deposit_amount, balance_amount) VALUES ($1, $2, 'deposit_pending', 60, 40) RETURNING *`,
      [`${ref}-B`, client.id]);
    const sql = fs.readFileSync(path.join(BACKEND, 'src', 'db', 'migrations', '0009_staff_ux.sql'), 'utf8');
    await bb.db.query(sql);
    await bb.db.query(sql);   // idempotent

    const { rows: quotes } = await bb.db.query(
      `SELECT q.*, o.id AS order_id FROM quotations q JOIN orders o ON o.quotation_id = q.id WHERE o.id = ANY($1::uuid[]) ORDER BY q.reference`,
      [[o.id, bare.id]]);
    assert.equal(quotes.length, 2);
    const legacy = quotes.find((q) => q.order_id === o.id);
    assert.equal(legacy.reference, `BRQ-Q-LEGACY-${ref}`);
    assert.deepEqual([legacy.status, Number(legacy.total), Number(legacy.subtotal), Number(legacy.vat)], ['accepted', 1150, 1000, 150]);
    assert.deepEqual(legacy.line_items, []);
    assert.equal(new Date(legacy.created_at).getTime(), new Date(o.created_at).getTime());
    assert.match(legacy.notes, /before quotes were linked/);
    assert.equal(Number(quotes.find((q) => q.order_id === bare.id).total), 100, 'deposit + balance when there is no total');
    const { rows: [{ n }] } = await bb.db.query(`SELECT COUNT(*)::int AS n FROM quotations WHERE reference LIKE $1`, [`BRQ-Q-LEGACY-${ref}%`]);
    assert.equal(n, 2, 'no duplicates on re-run');

    const board = await bb.ok(bb.api('GET', `/api/jobs?clientId=${client.id}`, { token: bb.admin.token }));
    assert.deepEqual(board.items.map((r) => r.state).sort(), ['AWAITING_DEPOSIT', 'IN_PRODUCTION']);
    // The dashboard's numbers are the board's: counts for a state = rows the board shows for it.
    const all = await bb.ok(bb.api('GET', '/api/jobs?limit=200', { token: bb.admin.token }));
    for (const state of ['IN_PRODUCTION', 'AWAITING_DEPOSIT', 'ACCEPTED']) {
      const filtered = await bb.ok(bb.api('GET', `/api/jobs?state=${state}&limit=200`, { token: bb.admin.token }));
      assert.equal(filtered.total, all.counts[state], state);
      assert.equal(filtered.items.length, all.counts[state], state);
    }
    const byOrder = await bb.ok(bb.api('GET', `/api/jobs/by-order/${o.id}`, { token: bb.admin.token }));
    assert.equal(byOrder.quotationId, legacy.id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Flags and guards', () => {
  test('BALANCE_DUE is not OVERDUE; a passed due date is', async () => {
    const o = await readyOrder();
    let row = (await bb.ok(bb.api('GET', `/api/jobs?search=${encodeURIComponent(o.reference)}`, { token: bb.admin.token }))).items[0];
    assert.ok(row.flags.includes('BALANCE_DUE'));
    assert.ok(!row.flags.includes('OVERDUE'));
    assert.equal(row.queue, 'ready');
    await bb.db.query(`UPDATE orders SET estimated_completion_date = '2020-01-01' WHERE id = $1`, [o.id]);
    row = (await bb.ok(bb.api('GET', `/api/jobs?search=${encodeURIComponent(o.reference)}`, { token: bb.admin.token }))).items[0];
    assert.ok(row.flags.includes('OVERDUE'));
    const overdue = await bb.ok(bb.api('GET', '/api/jobs?overdue=true&limit=200', { token: bb.admin.token }));
    assert.equal(overdue.total, overdue.flagCounts.OVERDUE);
  });

  test('a blocked advance lists every blocking guard with its message (the override dialog shows them all)', async () => {
    const o = await bb.order(await bb.makeClient());
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/p.png' } }));
    const r = await bb.advance(o.id);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.guards, ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
    assert.deepEqual(r.json.blockers.map((b) => [b.code, b.overridable]), [['PROOF_PENDING', true], ['DEPOSIT_REQUIRED', true]]);
    assert.ok(r.json.blockers.every((b) => b.message.length > 10));
    const start = act((await job(o.quotation_id)).lifecycle, 'start_production');
    assert.deepEqual(start.blockers.map((b) => b.code), ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
  });

  test('WITH_CONSULTANT ("Client waiting") only while the client waits for a person', async () => {
    const phone = await bb.registeredPhone();
    const client = await bb.clientOf(phone);
    const q = await bb.sentQuote(client);
    const convo = await bb.convoOf(phone);
    await bb.db.query(`UPDATE conversations SET state = 'consultant_active' WHERE id = $1`, [convo.id]);
    assert.ok(!(await job(q.id)).lifecycle.flags.includes('WITH_CONSULTANT'));
    await bb.db.query(`UPDATE conversations SET state = 'awaiting_consultant' WHERE id = $1`, [convo.id]);
    assert.ok((await job(q.id)).lifecycle.flags.includes('WITH_CONSULTANT'));
    const meta = await bb.ok(bb.api('GET', '/api/meta', { token: bb.admin.token }));
    assert.equal(meta.jobFlags.find((f) => f.key === 'WITH_CONSULTANT').label, 'Client waiting');
    assert.ok(meta.jobFlags.some((f) => f.key === 'BALANCE_DUE'));
    assert.equal(meta.jobQueues[0].key, 'accepted');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Quote editing', () => {
  test('PUT /api/quotations/:id autosaves a draft (incomplete lines allowed); 409 once sent', async () => {
    const client = await bb.makeClient();
    const { quotation: q } = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id } }), 201);
    const saved = await bb.ok(bb.api('PUT', `/api/quotations/${q.id}`, {
      token: bb.admin.token,
      body: { lineItems: [{ name: '', quantity: 0, unitPrice: 0 }, item('Polo', 4, 100)], notes: '20 polos, navy', validUntil: '2031-01-31' },
    }));
    assert.equal(saved.quotation.status, 'draft');
    assert.equal(saved.quotation.line_items.length, 2);
    assert.deepEqual([Number(saved.quotation.subtotal), Number(saved.quotation.total)], [400, 460]);
    assert.equal(saved.quotation.notes, '20 polos, navy');
    assert.equal((await bb.api('PUT', `/api/quotations/${q.id}`, { token: bb.admin.token, body: {} })).status, 400);
    assert.equal((await bb.api('PUT', `/api/quotations/${q.id}`, { body: { notes: 'x' } })).status, 401);

    // Sending keeps a validity date chosen while drafting.
    const sent = await bb.ok(bb.api('POST', `/api/quotations/${q.id}/approve`, { token: bb.admin.token, body: { lineItems: [item('Polo', 4, 100)] } }));
    assert.equal(String(sent.quotation.valid_until).slice(0, 4), '2031');
    const r = await bb.api('PUT', `/api/quotations/${q.id}`, { token: bb.admin.token, body: { notes: 'too late' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'QUOTE_NOT_DRAFT');
  });

  test('draft PDF: staff can preview it; without a token it stays hidden; a sent quote is public', async () => {
    const client = await bb.makeClient();
    const { quotation: q } = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id, lineItems: [item('Polo', 4, 100)] } }), 201);
    const anon = await fetch(`${bb.env.baseUrl}/api/quotations/${q.id}/pdf`);
    assert.equal(anon.status, 404);
    const bad = await fetch(`${bb.env.baseUrl}/api/quotations/${q.id}/pdf`, { headers: { Authorization: 'Bearer nonsense' } });
    assert.equal(bad.status, 404);
    const staff = await fetch(`${bb.env.baseUrl}/api/quotations/${q.id}/pdf`, { headers: { Authorization: `Bearer ${bb.consultant.token}` } });
    assert.equal(staff.status, 200);
    assert.match(staff.headers.get('content-type'), /pdf/);
    await bb.ok(bb.api('POST', `/api/quotations/${q.id}/approve`, { token: bb.admin.token, body: { lineItems: [item('Polo', 4, 100)] } }));
    assert.equal((await fetch(`${bb.env.baseUrl}/api/quotations/${q.id}/pdf`)).status, 200);
  });

  test('a quote started from a chat copies what the client asked for (inbound messages since their last quote)', async () => {
    const phone = await bb.registeredPhone();
    const client = await bb.clientOf(phone);
    const convo = await bb.convoOf(phone);
    await bb.db.query(
      `INSERT INTO messages (conversation_id, client_id, body, direction, created_at) VALUES
         ($1, $2, 'Need 20 navy golf shirts', 'inbound', now() - interval '3 seconds'),
         ($1, $2, 'Our bot reply', 'outbound', now() - interval '2 seconds'),
         ($1, $2, 'Logo on the left chest please', 'inbound', now() - interval '1 second')`, [convo.id, client.id]);
    const { quotation } = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id, conversationId: convo.id } }), 201);
    const lines = quotation.notes.split('\n');
    assert.ok(lines.includes('Need 20 navy golf shirts'), quotation.notes);
    assert.ok(lines.indexOf('Logo on the left chest please') > lines.indexOf('Need 20 navy golf shirts'), 'oldest first');
    assert.ok(!quotation.notes.includes('Our bot reply'));
    // Explicit notes win; a second quote only copies messages after the first.
    const { quotation: q2 } = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.admin.token, body: { clientId: client.id, conversationId: convo.id } }), 201);
    assert.equal(q2.notes, null);
  });

  test('the job conversation shows the client\'s last message (not ours)', async () => {
    const phone = await bb.registeredPhone();
    const client = await bb.clientOf(phone);
    const q = await bb.sentQuote(client);
    const j = await job(q.id);
    assert.equal(j.conversation.last_inbound.direction, 'inbound');
    assert.equal(j.conversation.last_inbound.body, 'hi');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Jobs list: queues and one-click actions', () => {
  test('a quoted job carries its one-click action; running its endpoint creates the order', async () => {
    const client = await bb.makeClient({ name: `OneClick ${rnd()}` });
    const q = await bb.sentQuote(client);
    const board = await bb.ok(bb.api('GET', `/api/jobs?clientId=${client.id}`, { token: bb.consultant.token }));
    const a = board.items[0].primary_action;
    assert.equal(a.key, 'accept_and_order');
    const r = await bb.ok(bb.api(a.endpoint.method, a.endpoint.path, { token: bb.consultant.token, body: a.endpoint.body }), 201);
    assert.equal(r.order.quotation_id, q.id);
    const next = await bb.ok(bb.api('GET', `/api/jobs?clientId=${client.id}`, { token: bb.consultant.token }));
    assert.equal(next.items[0].state, 'AWAITING_DEPOSIT');
    assert.equal(next.items[0].primary_action, null, 'the deposit needs an amount');
    assert.equal(next.items[0].queue, 'deposit');
  });

  test('queue filter + queue counts; Mine (owner=me) counts match the filtered list', async () => {
    const client = await bb.makeClient();
    await bb.acceptedQuote(client, { token: bb.consultant.token });
    const all = await bb.ok(bb.api('GET', '/api/jobs?limit=200', { token: bb.consultant.token }));
    const accepted = await bb.ok(bb.api('GET', '/api/jobs?queue=accepted&limit=200', { token: bb.consultant.token }));
    assert.equal(accepted.total, all.queueCounts.accepted);
    assert.ok(accepted.items.every((r) => r.queue === 'accepted' && r.state === 'ACCEPTED'));
    const mine = await bb.ok(bb.api('GET', '/api/jobs?owner=me&queue=accepted&limit=200', { token: bb.consultant.token }));
    assert.equal(mine.total, mine.queueCounts.accepted);
    assert.ok(mine.items.every((r) => r.owner_id === bb.consultant.id));
    assert.equal((await bb.api('GET', '/api/jobs?queue=nope', { token: bb.admin.token })).status, 400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('WhatsApp 24-hour window: business messages carry a template fallback', () => {
  test('order created / stage / payment / proof / hold / ticket resolved / staff reply → whatsapp.send with templateFallback', async () => {
    const phone = await bb.registeredPhone(`Thandi ${rnd()}`);
    const client = await bb.clientOf(phone);
    const convo = await bb.convoOf(phone);
    const fallbacks = async () => (await bb.db.query(
      `SELECT payload->'templateFallback' AS f FROM jobs WHERE type = 'whatsapp.send' AND payload->>'to' = $1 ORDER BY id`, [phone])).rows
      .map((r) => r.f).filter(Boolean);
    const o = await bb.order(client);                                                        // order_stage (deposit pending)
    await bb.pay(o.id, 'deposit', 690);                                                     // payment_received
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/p.pdf' } }));   // proof_ready
    await bb.ok(bb.api('PATCH', `/api/orders/${o.id}/proof/status`, { token: bb.admin.token, body: { status: 'approved' } }));
    await bb.ok(bb.advance(o.id, { estimatedCompletion: '2030-06-01' }));                    // order_stage (in production)
    await bb.ok(bb.api('PATCH', `/api/orders/${o.id}/hold`, { token: bb.admin.token, body: { isOnHold: true, holdReason: 'supplier_delay' } }));   // order_delay
    const { ticket } = await bb.ok(bb.api('POST', '/api/tickets', { token: bb.admin.token, body: { clientId: client.id, orderId: o.id, category: 'other', description: 'Logo colour wrong' } }), 201);
    await bb.ok(bb.api('PATCH', `/api/tickets/${ticket.id}`, { token: bb.admin.token, body: { status: 'resolved', resolutionNote: 'Reprinted' } }));   // ticket_resolved
    await bb.ok(bb.api('POST', `/api/conversations/${convo.id}/reply`, { token: bb.consultant.token, body: { body: 'Your shirts are on the way' } }));   // consultant_reply
    const f = await fallbacks();
    const names = f.map((x) => x.name);
    for (const n of ['order_stage', 'payment_received', 'proof_ready', 'order_delay', 'ticket_resolved', 'consultant_reply']) assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
    const stage = f.filter((x) => x.name === 'order_stage');
    assert.deepEqual(stage.map((x) => x.params[0]), stage.map(() => 'Thandi'), 'first name');
    assert.ok(stage.some((x) => x.params[2] === 'In Production' && /Estimated completion/.test(x.params[3])));
    assert.deepEqual(f.find((x) => x.name === 'proof_ready').params.slice(1), [o.reference, 'https://example.com/p.pdf']);
    assert.deepEqual(f.find((x) => x.name === 'consultant_reply').params, ['Thandi', 'Connie Consultant', 'Your shirts are on the way']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('Tickets, clients and the inbox', () => {
  test('an open ticket can be resolved from the job whatever its state', async () => {
    const o = await bb.order(await bb.makeClient());
    await bb.pay(o.id, 'deposit', 690);
    await bb.ok(bb.advance(o.id));
    const { ticket } = await bb.ok(bb.api('POST', '/api/tickets', { token: bb.admin.token, body: { clientId: o.client_id, orderId: o.id, category: 'other', description: 'Change the logo colour' } }), 201);
    const { lifecycle } = await job(o.quotation_id);
    assert.equal(lifecycle.state, 'IN_PRODUCTION');
    const resolve = act(lifecycle, 'resolve_ticket');
    assert.equal(resolve.ticketId, ticket.id);
    assert.equal(resolve.primary, false);
    await bb.ok(bb.api(resolve.endpoint.method, resolve.endpoint.path, { token: bb.consultant.token, body: { ...resolve.endpoint.body, resolutionNote: 'Done' } }));
    const after = await job(o.quotation_id);
    assert.equal(after.tickets[0].status, 'resolved');
    assert.ok(!after.lifecycle.nextActions.some((x) => x.key === 'resolve_ticket'));
  });

  test('client page: open (or start) the chat; money across orders', async () => {
    const client = await bb.makeClient();
    const first = await bb.ok(bb.api('POST', `/api/clients/${client.id}/conversation`, { token: bb.consultant.token }), 201);
    assert.equal(first.created, true);
    const again = await bb.ok(bb.api('POST', `/api/clients/${client.id}/conversation`, { token: bb.consultant.token }));
    assert.deepEqual([again.created, again.conversation.id], [false, first.conversation.id]);
    const o = await bb.order(client);
    await bb.pay(o.id, 'deposit', 690);
    await bb.order(client);
    const { summary } = await bb.ok(bb.api('GET', `/api/clients/${client.id}`, { token: bb.admin.token }));
    assert.deepEqual(summary, { orders: 2, total: 2300, paid: 690, outstanding: 1610 });
  });

  test('inbox: a staff reply is marked as theirs; list rows carry the sender and the client\'s job state', async () => {
    const phone = await bb.registeredPhone();
    const client = await bb.clientOf(phone);
    await bb.sentQuote(client);
    await bb.env.waitForJobs();   // the quote PDF is recorded when the worker sends it
    const convo = await bb.convoOf(phone);
    await bb.ok(bb.api('POST', `/api/conversations/${convo.id}/reply`, { token: bb.consultant.token, body: { body: 'Hello from Connie' } }));
    // (a first reply may be followed by an automatic "X is now helping you" message — the second is last)
    await bb.ok(bb.api('POST', `/api/conversations/${convo.id}/reply`, { token: bb.consultant.token, body: { body: 'Your quote is attached' } }));
    const list = await bb.ok(bb.api('GET', `/api/conversations?clientId=${client.id}&isOpen=all`, { token: bb.admin.token }));
    const row = list.items[0];
    assert.equal(row.last_message_direction, 'outbound');
    assert.deepEqual(row.last_message_sender, { id: bb.consultant.id, name: 'Connie Consultant' });
    assert.equal(row.latest_job.state, 'QUOTED');
    const { messages } = await bb.ok(bb.api('GET', `/api/conversations/${convo.id}`, { token: bb.admin.token }));
    const mine = messages.find((m) => m.body === 'Hello from Connie');
    assert.equal(mine.sent_by_name, 'Connie Consultant');
    assert.ok(messages.filter((m) => m.direction === 'outbound' && !['Hello from Connie', 'Your quote is attached'].includes(m.body))
      .every((m) => m.sent_by_name == null), 'bot messages have no sender');
  });
});
