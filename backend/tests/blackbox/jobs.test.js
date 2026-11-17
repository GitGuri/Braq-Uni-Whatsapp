/**
 * Black-box: GET /api/jobs (the board: states, counts, filters, search,
 * owner, overdue, paging), GET /api/jobs/:quotationId (full job + merged
 * history timeline), GET /api/jobs/by-order/:orderId, and GET /api/meta
 * (shape + permissions per role).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlackbox, item } from '../helpers/blackbox.js';

let bb;
const jobs = {};   // state → { quotationId, orderId?, client }

before(async () => {
  bb = await startBlackbox();
  const mk = (name) => bb.makeClient({ name: `Board ${name}` });

  // PRICING (owned by the consultant, SLA breached → overdue)
  let c = await mk('Pricing');
  const draft = await bb.ok(bb.api('POST', '/api/quotations', { token: bb.consultant.token, body: { clientId: c.id, notes: 'blazers' } }), 201);
  await bb.db.query(`UPDATE quotations SET sla_remind_at = now() - interval '1 hour' WHERE id = $1`, [draft.quotation.id]);
  jobs.PRICING = { quotationId: draft.quotation.id, client: c };

  // PRICING, unassigned (bot-style draft)
  c = await mk('Unclaimed');
  const { rows: [bot] } = await bb.db.query(
    `INSERT INTO quotations (reference, client_id, status, line_items) VALUES ('BRQ-Q-20261021-9001', $1, 'draft', '[]') RETURNING id`, [c.id]);
  jobs.UNCLAIMED = { quotationId: bot.id, client: c };

  c = await mk('Quoted');
  jobs.QUOTED = { quotationId: (await bb.sentQuote(c)).id, client: c };

  c = await mk('Expired');
  const exp = await bb.sentQuote(c);
  await bb.db.query(`UPDATE quotations SET valid_until = '2020-01-01' WHERE id = $1`, [exp.id]);
  jobs.EXPIRED = { quotationId: exp.id, client: c };

  c = await mk('Declined');
  const dec = await bb.sentQuote(c);
  await bb.ok(bb.api('PATCH', `/api/quotations/${dec.id}/status`, { token: bb.admin.token, body: { status: 'rejected' } }));
  jobs.DECLINED = { quotationId: dec.id, client: c };

  c = await mk('Accepted');
  jobs.ACCEPTED = { quotationId: (await bb.acceptedQuote(c)).id, client: c };

  const orderJob = async (state, setup) => {
    const client = await mk(state);
    const o = await bb.order(client, { token: bb.consultant.token });
    await setup?.(o);
    jobs[state] = { quotationId: o.quotation_id, orderId: o.id, order: o, client };
  };
  await orderJob('AWAITING_DEPOSIT');
  await orderJob('READY_TO_PRODUCE', (o) => bb.pay(o.id, 'deposit', Number(o.deposit_amount)));
  await orderJob('AWAITING_PROOF', async (o) => {
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    await bb.ok(bb.api('POST', `/api/orders/${o.id}/proof`, { token: bb.admin.token, body: { proofUrl: 'https://example.com/proof.png' } }));
  });
  await orderJob('IN_PRODUCTION', async (o) => {
    await bb.pay(o.id, 'deposit', Number(o.deposit_amount));
    await bb.ok(bb.advance(o.id, { estimatedCompletion: '2020-02-02' }));      // due date in the past → overdue
  });
  await orderJob('READY', async (o) => {
    await bb.ok(bb.advance(o.id, { override: { reason: 'Account client on terms' } }, bb.manager.token));
    await bb.ok(bb.advance(o.id));
  });
  await orderJob('COMPLETED', async (o) => {
    await bb.pay(o.id, 'full', Number(o.total_amount));
    await bb.ok(bb.advance(o.id)); await bb.ok(bb.advance(o.id)); await bb.ok(bb.advance(o.id));
  });
  await orderJob('AFTER_SALES', async (o) => {
    await bb.pay(o.id, 'full', Number(o.total_amount));
    await bb.ok(bb.advance(o.id)); await bb.ok(bb.advance(o.id)); await bb.ok(bb.advance(o.id));
    await bb.ok(bb.api('POST', '/api/tickets', { token: bb.admin.token, body: { clientId: o.client_id, orderId: o.id, category: 'defective', description: 'Seams split on two shirts' } }), 201);
  });
  await bb.env.waitForJobs();
}, { timeout: 300000 });
after(async () => { await bb?.stop(); });

const board = (qs = '', token = bb.admin.token) => bb.ok(bb.api('GET', `/api/jobs${qs}`, { token }));
const STATES = ['PRICING', 'QUOTED', 'EXPIRED', 'DECLINED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'AWAITING_PROOF', 'READY_TO_PRODUCE', 'IN_PRODUCTION', 'READY', 'COMPLETED', 'AFTER_SALES'];

describe('GET /api/jobs (board)', () => {
  test('every job appears once with the state the detail page derives (SQL board == JS lifecycle)', async () => {
    const all = await board('?limit=200');
    for (const [label, j] of Object.entries(jobs)) {
      const rows = all.items.filter((r) => r.quotation_id === j.quotationId);
      assert.equal(rows.length, 1, `${label} listed once`);
      const detail = await bb.ok(bb.api('GET', `/api/jobs/${j.quotationId}`, { token: bb.admin.token }));
      assert.equal(rows[0].state, detail.lifecycle.state, `${label}: board vs detail`);
      assert.deepEqual([...rows[0].flags].sort(), [...detail.lifecycle.flags].sort(), `${label}: flags board vs detail`);
      if (label !== 'UNCLAIMED') assert.equal(rows[0].state, label, label);
    }
  });

  test('response shape: items + total + page + limit + counts for every state', async () => {
    const r = await board('?limit=200');
    // UX round 2 added queueCounts / flagCounts (dashboard queues and cells use the board's own counts).
    assert.deepEqual(Object.keys(r).sort(), ['counts', 'flagCounts', 'items', 'limit', 'page', 'queueCounts', 'total']);
    for (const s of STATES) assert.ok(r.counts[s] >= 1, `count for ${s}`);
    assert.equal(r.counts.CANCELLED, 0);
    assert.equal(r.total, Object.values(r.counts).reduce((a, b) => a + b, 0));
    const row = r.items.find((x) => x.quotation_id === jobs.AWAITING_DEPOSIT.quotationId);
    assert.deepEqual(Object.keys(row).sort(), [
      'account_terms', 'client_id', 'client_name', 'created_at', 'due_date', 'expires_on', 'flags', 'order_id', 'order_reference', 'organisation',
      'owner_id', 'owner_name', 'primary_action', 'queue', 'quotation_id', 'quotation_reference', 'sent_at', 'state', 'state_label', 'total', 'updated_at']);
    assert.deepEqual([row.order_id, row.order_reference, row.owner_id, row.owner_name, row.state_label],
      [jobs.AWAITING_DEPOSIT.orderId, jobs.AWAITING_DEPOSIT.order.reference, bb.consultant.id, 'Connie Consultant', 'Awaiting deposit']);
  });

  test('filter by one or several states; counts ignore the state filter; unknown state → 400', async () => {
    const r = await board('?state=AWAITING_DEPOSIT&limit=200');
    assert.ok(r.items.length >= 1 && r.items.every((x) => x.state === 'AWAITING_DEPOSIT'));
    assert.equal(r.total, r.counts.AWAITING_DEPOSIT);
    assert.ok(r.counts.QUOTED >= 1, 'counts still cover every state');
    const two = await board('?state=quoted,accepted&limit=200');
    assert.deepEqual([...new Set(two.items.map((x) => x.state))].sort(), ['ACCEPTED', 'QUOTED']);
    const bad = await bb.api('GET', '/api/jobs?state=NOPE', { token: bb.admin.token });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await bb.api('GET', '/api/jobs?owner=everyone', { token: bb.admin.token })).status, 400);
  });

  test('owner=me / owner=unassigned', async () => {
    const mine = await board('?owner=me&limit=200', bb.consultant.token);
    assert.ok(mine.items.length >= 8);
    assert.ok(mine.items.every((x) => x.owner_id === bb.consultant.id));
    assert.ok(mine.items.some((x) => x.quotation_id === jobs.PRICING.quotationId));
    const none = await board('?owner=unassigned&limit=200');
    assert.ok(none.items.every((x) => x.owner_id === null));
    const unclaimed = none.items.find((x) => x.quotation_id === jobs.UNCLAIMED.quotationId);
    assert.ok(unclaimed.flags.includes('UNASSIGNED'));
  });

  // Changed in UX round 2: a balance owed when ready is BALANCE_DUE, not overdue.
  test('overdue=true: pricing SLA breached, due date passed — listed first by default; ready + owing is BALANCE_DUE', async () => {
    const od = await board('?overdue=true&limit=200');
    const ids = od.items.map((x) => x.quotation_id);
    for (const s of ['PRICING', 'IN_PRODUCTION']) assert.ok(ids.includes(jobs[s].quotationId), `${s} overdue`);
    assert.ok(!ids.includes(jobs.QUOTED.quotationId));
    assert.ok(!ids.includes(jobs.READY.quotationId), 'balance owed is not overdue');
    const ready = (await board('?state=READY&limit=200')).items.find((x) => x.quotation_id === jobs.READY.quotationId);
    assert.ok(ready.flags.includes('BALANCE_DUE'));
    assert.ok(od.items.every((x) => x.flags.includes('OVERDUE')));
    const all = await board('?limit=200');
    const firstNot = all.items.findIndex((x) => !x.flags.includes('OVERDUE'));
    assert.ok(all.items.slice(firstNot).every((x) => !x.flags.includes('OVERDUE')), 'overdue first');
  });

  test('search by quotation reference, order reference and client name (case-insensitive, literal)', async () => {
    const byClient = await board(`?search=${encodeURIComponent('board quoted')}`);
    assert.deepEqual(byClient.items.map((x) => x.quotation_id), [jobs.QUOTED.quotationId]);
    const byOrderRef = await board(`?search=${jobs.READY.order.reference}`);
    assert.deepEqual(byOrderRef.items.map((x) => x.quotation_id), [jobs.READY.quotationId]);
    const byQuoteRef = await board('?search=BRQ-Q-20261021-9001');
    assert.deepEqual(byQuoteRef.items.map((x) => x.quotation_id), [jobs.UNCLAIMED.quotationId]);
    const wild = await board(`?search=${encodeURIComponent('%')}`);
    assert.equal(wild.items.length, 0);
  });

  test('pagination: disjoint pages, clamped garbage params', async () => {
    const p1 = await board('?limit=3&page=1');
    const p2 = await board('?limit=3&page=2');
    assert.equal(p1.items.length, 3);
    assert.equal(p1.limit, 3);
    assert.equal(p2.page, 2);
    assert.equal(p1.items.filter((x) => p2.items.some((y) => y.quotation_id === x.quotation_id)).length, 0);
    const g = await bb.api('GET', '/api/jobs?limit=abc&page=-1', { token: bb.admin.token });
    assert.equal(g.status, 200, g.text);
    assert.equal((await bb.api('GET', '/api/jobs')).status, 401);
  });
});

describe('GET /api/jobs/:quotationId', () => {
  test('full job: quotation, order, payments, sizes, tickets, conversation, client, lifecycle', async () => {
    const j = jobs.AFTER_SALES;
    const r = await bb.ok(bb.api('GET', `/api/jobs/${j.quotationId}`, { token: bb.admin.token }));
    assert.deepEqual(Object.keys(r).sort(), ['client', 'conversation', 'history', 'lifecycle', 'order', 'payments', 'purchaseOrders', 'quotation', 'sizes', 'tickets']);
    assert.equal(r.quotation.id, j.quotationId);
    assert.equal(r.order.id, j.orderId);
    assert.equal(r.client.id, j.client.id);
    assert.equal(r.payments.length, 1);
    assert.deepEqual(r.sizes, []);
    assert.equal(r.tickets.length, 1);
    assert.equal(r.lifecycle.state, 'AFTER_SALES');
    assert.equal(r.lifecycle.nextActions[0].key, 'resolve_ticket');
    assert.equal(r.lifecycle.nextActions[0].ticketId, r.tickets[0].id);
  });

  test('history: one ascending timeline of quote events, order creation, payments, proof, stage moves (with overrides) and messages', async () => {
    const proof = await bb.ok(bb.api('GET', `/api/jobs/${jobs.AWAITING_PROOF.quotationId}`, { token: bb.admin.token }));
    const types = proof.history.map((e) => e.type);
    for (const t of ['quotation.created', 'quotation.accepted', 'order.created', 'payment.recorded', 'proof.sent', 'message']) {
      assert.ok(types.includes(t), `${t} in ${types.join(', ')}`);
    }
    const at = proof.history.map((e) => Date.parse(e.at));
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'ascending');
    assert.ok(proof.history.some((e) => e.type === 'message' && e.data.direction === 'outbound' && /Design Proof Ready/.test(e.data.body)), 'outbound WhatsApp in the timeline');

    const ready = await bb.ok(bb.api('GET', `/api/jobs/${jobs.READY.quotationId}`, { token: bb.admin.token }));
    const over = ready.history.find((e) => e.type === 'stage.overridden');
    assert.ok(over, ready.history.map((e) => e.type).join(', '));
    assert.deepEqual([over.data.from_stage, over.data.stage, over.data.override.reason, over.data.override.guards, over.actor_name],
      ['deposit_pending', 'in_production', 'Account client on terms', ['DEPOSIT_REQUIRED'], 'Mandla Manager']);
    assert.ok(ready.history.some((e) => e.type === 'stage.changed' && e.data.stage === 'ready'));

    const quoted = await bb.ok(bb.api('GET', `/api/jobs/${jobs.QUOTED.quotationId}`, { token: bb.admin.token }));
    assert.deepEqual(quoted.history.filter((e) => e.type.startsWith('quotation.')).map((e) => e.type), ['quotation.created', 'quotation.sent']);
    assert.equal(quoted.order, null);
    assert.deepEqual(quoted.payments, []);
  });

  test('404 unknown, 400 malformed, 401 anonymous', async () => {
    assert.equal((await bb.api('GET', '/api/jobs/00000000-0000-4000-8000-000000000000', { token: bb.admin.token })).status, 404);
    assert.equal((await bb.api('GET', '/api/jobs/not-a-uuid', { token: bb.admin.token })).status, 400);
    assert.equal((await bb.api('GET', `/api/jobs/${jobs.QUOTED.quotationId}`)).status, 401);
  });
});

describe('GET /api/jobs/by-order/:orderId', () => {
  test('maps an order to its job; legacy order without a quote → quotationId null; 404 / 400', async () => {
    const j = jobs.IN_PRODUCTION;
    assert.deepEqual(await bb.ok(bb.api('GET', `/api/jobs/by-order/${j.orderId}`, { token: bb.consultant.token })),
      { orderId: j.orderId, quotationId: j.quotationId });
    const c = await bb.makeClient();
    const { rows: [legacy] } = await bb.db.query(
      `INSERT INTO orders (reference, client_id, stage) VALUES ('BRQ-O-L0001', $1, 'manufacturing') RETURNING id`, [c.id]);
    assert.deepEqual(await bb.ok(bb.api('GET', `/api/jobs/by-order/${legacy.id}`, { token: bb.admin.token })), { orderId: legacy.id, quotationId: null });
    assert.equal((await bb.api('GET', '/api/jobs/by-order/00000000-0000-4000-8000-000000000000', { token: bb.admin.token })).status, 404);
    assert.equal((await bb.api('GET', '/api/jobs/by-order/xyz', { token: bb.admin.token })).status, 400);
  });
});

describe('GET /api/meta', () => {
  test('shape: stages, legacy stages, job states, statuses, enums, bot states and the business numbers', async () => {
    const m = await bb.ok(bb.api('GET', '/api/meta', { token: bb.consultant.token }));
    for (const k of ['stages', 'legacyStages', 'jobStates', 'jobJourney', 'jobFlags', 'quotationStatuses', 'paymentStatuses', 'paymentTypes',
      'proofStatuses', 'ticketStatuses', 'ticketCategories', 'clientTypes', 'productCategories', 'botStates', 'humanStates',
      'currency', 'vatRate', 'vatPercent', 'depositPercent', 'quoteValidityDays', 'quoteSlaHours', 'ticketSlaHours', 'role', 'permissions']) {
      assert.ok(k in m, `meta.${k}`);
    }
    assert.deepEqual(m.stages.map((s) => [s.key, s.label]), [
      ['deposit_pending', 'Awaiting deposit'], ['in_production', 'In production'], ['ready', 'Ready'], ['completed', 'Completed']]);
    assert.equal(m.legacyStages.manufacturing, 'in_production');
    assert.ok(m.jobStates.some((s) => s.key === 'AWAITING_PROOF' && s.label && s.description));
    assert.deepEqual(m.quotationStatuses.map((s) => s.key), ['draft', 'sent', 'accepted', 'rejected', 'expired']);
    assert.ok(m.botStates.includes('awaiting_consultant') && m.botStates.includes('proof_review'));
    assert.deepEqual([...m.humanStates].sort(), ['awaiting_consultant', 'consultant_active']);
    assert.deepEqual([m.vatRate, m.vatPercent, m.depositPercent, m.quoteValidityDays, m.ticketSlaHours, m.currency], [0.15, 15, 60, 30, 4, 'ZAR']);
  });

  test('permissions per role', async () => {
    const perms = async (token) => (await bb.ok(bb.api('GET', '/api/meta', { token }))).permissions;
    const admin = await perms(bb.admin.token);
    const manager = await perms(bb.manager.token);
    const consultant = await perms(bb.consultant.token);
    assert.ok(admin.includes('order.override') && admin.includes('staff.manage') && admin.includes('po.create'));
    assert.ok(manager.includes('order.override') && manager.includes('po.create') && !manager.includes('staff.manage'));
    assert.deepEqual(consultant, []);
    assert.equal((await bb.ok(bb.api('GET', '/api/meta', { token: bb.manager.token }))).role, 'manager');
    assert.equal((await bb.api('GET', '/api/meta')).status, 401);
  });
});
