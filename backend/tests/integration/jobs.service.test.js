// jobs service against a real Postgres: the board's SQL job state / flags
// (lifecycle/sql.js) must agree with the JS rules (lifecycle/derive.js) for
// every combination of quotation / order / payment / proof / hold / ticket /
// conversation; filters, counts and the job timeline.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const jobs = await t.load('modules/jobs/service.js');
const { recordJobEvent } = await t.load('modules/jobs/events.js');

beforeEach(() => t.reset());
after(() => t.stop());

let seq = 0;
async function job({ q = {}, o = null, ticket = null, convo = null, account = false } = {}) {
  const client = await t.factory.client({ name: `Matrix ${++seq}` });
  if (account) await t.query('UPDATE clients SET account_terms = true WHERE id = $1', [client.id]);
  const staff = q.owner === null ? null : (q.owner ?? (await t.factory.staff()));
  const quote = await t.factory.quotation({
    client_id: client.id, status: q.status ?? 'sent', valid_until: q.valid_until ?? '2999-01-01',
    assigned_staff_id: staff?.id ?? null, total: '115.00',
  });
  if (q.sla) await t.query(`UPDATE quotations SET sla_remind_at = now() + ($1 || ' minutes')::interval WHERE id = $2`, [q.sla, quote.id]);
  let order = null;
  if (o) {
    order = await t.factory.order({
      client_id: client.id, quotation_id: quote.id, stage: o.stage ?? 'deposit_pending', payment_status: o.payment_status ?? 'unpaid',
      proof_status: o.proof_status ?? 'none', is_on_hold: o.is_on_hold ?? false, estimated_completion_date: o.due ?? null,
      assigned_staff_id: o.owner === undefined ? staff?.id ?? null : o.owner, deposit_amount: '69.00', balance_amount: '46.00',
    });
    if (o.cancelled) await t.query(`UPDATE orders SET cancelled_at = now() WHERE id = $1`, [order.id]);
  }
  if (ticket) {
    await t.query(`INSERT INTO tickets (client_id, order_id, category, description, sla_due_at, status) VALUES ($1,$2,'other','x',now(),$3)`,
      [client.id, order?.id ?? null, ticket]);
  }
  if (convo) await t.factory.conversation({ client_id: client.id, state: convo });
  return { quote, order, client };
}

describe('board SQL state/flags == JS lifecycle', () => {
  test('matrix of quotation / order combinations', async () => {
    const cases = [
      { q: { status: 'draft' } },
      { q: { status: 'draft', sla: -30 } },
      { q: { status: 'draft', sla: 30, owner: null } },
      { q: { status: 'sent' } },
      { q: { status: 'sent', valid_until: '2020-01-01' } },
      { q: { status: 'expired', owner: null } },
      { q: { status: 'rejected' } },
      { q: { status: 'accepted' }, convo: 'awaiting_consultant' },
      { q: { status: 'accepted' }, o: {} },
      { q: { status: 'accepted' }, o: { proof_status: 'sent' } },
      { q: { status: 'accepted' }, o: { payment_status: 'deposit_paid', proof_status: 'revision_requested' } },
      { q: { status: 'accepted' }, o: { payment_status: 'deposit_paid', proof_status: 'approved', is_on_hold: true } },
      { q: { status: 'accepted' }, o: { payment_status: 'not_required' }, convo: 'consultant_active' },
      { q: { status: 'accepted' }, o: { stage: 'po_received', payment_status: 'deposit_paid' } },
      { q: { status: 'accepted' }, o: { stage: 'in_production', due: '2020-01-01' } },
      { q: { status: 'accepted' }, o: { stage: 'manufacturing', due: '2999-01-01', owner: null } },
      { q: { status: 'accepted', owner: null }, o: { stage: 'in_production', owner: null } },
      { q: { status: 'accepted' }, o: { stage: 'ready', payment_status: 'deposit_paid' } },
      { q: { status: 'accepted' }, o: { stage: 'packing_dispatch', payment_status: 'paid_in_full' } },
      { q: { status: 'accepted' }, o: { stage: 'completed', payment_status: 'paid_in_full', due: '2020-01-01' } },
      { q: { status: 'accepted' }, o: { stage: 'completed', payment_status: 'paid_in_full' }, ticket: 'open' },
      { q: { status: 'accepted' }, o: { stage: 'completed', payment_status: 'paid_in_full' }, ticket: 'resolved' },
      { q: { status: 'accepted' }, o: { stage: 'cancelled' } },
      { q: { status: 'accepted' }, o: { cancelled: true } },
      // account clients: no deposit needed (straight to ready to produce / the proof)
      { q: { status: 'accepted' }, o: {}, account: true },
      { q: { status: 'accepted' }, o: { proof_status: 'sent' }, account: true },
      { q: { status: 'accepted' }, o: { stage: 'ready', payment_status: 'unpaid' }, account: true },
      // an accepted quote past its validity without an order is overdue
      { q: { status: 'accepted', valid_until: '2020-01-01' } },
    ];
    const made = [];
    for (const c of cases) made.push({ c, ...(await job(c)) });
    const board = await jobs.listJobs({ limit: '200' }, null);
    assert.equal(board.total, cases.length);
    const seenStates = new Set();
    for (const { c, quote } of made) {
      const row = board.items.find((r) => r.quotation_id === quote.id);
      const detail = await jobs.getJob(quote.id, null);
      assert.equal(row.state, detail.lifecycle.state, `state ${JSON.stringify(c)}`);
      assert.deepEqual([...row.flags].sort(), [...detail.lifecycle.flags].sort(), `flags ${JSON.stringify(c)}`);
      seenStates.add(row.state);
    }
    assert.equal(seenStates.size, 13, `all 13 job states covered: ${[...seenStates].join(', ')}`);
  });
});

describe('listJobs filters and counts', () => {
  test('counts per state ignore the state filter; owner / overdue / search / clientId filters', async () => {
    const me = await t.factory.staff({ name: 'Me' });
    const a = await job({ q: { status: 'draft', owner: me, sla: -5 } });
    const b = await job({ q: { status: 'sent', owner: null } });
    await job({ q: { status: 'accepted' }, o: { stage: 'ready', payment_status: 'deposit_paid' } });
    const r = await jobs.listJobs({ state: 'PRICING' }, me);
    assert.deepEqual(r.items.map((x) => x.quotation_id), [a.quote.id]);
    assert.deepEqual([r.counts.PRICING, r.counts.QUOTED, r.counts.READY, r.total], [1, 1, 1, 1]);
    assert.deepEqual((await jobs.listJobs({ owner: 'me' }, me)).items.map((x) => x.quotation_id), [a.quote.id]);
    assert.deepEqual((await jobs.listJobs({ owner: 'unassigned' }, me)).items.map((x) => x.quotation_id), [b.quote.id]);
    // The ready job owes its balance: BALANCE_DUE, not overdue.
    assert.equal((await jobs.listJobs({ overdue: 'true' }, me)).total, 1);
    assert.deepEqual([r.flagCounts.OVERDUE, r.flagCounts.BALANCE_DUE], [1, 1]);
    const ready = (await jobs.listJobs({ state: 'READY' }, me)).items[0];
    assert.deepEqual(ready.flags, ['BALANCE_DUE']);
    assert.equal(ready.queue, 'ready');
    assert.deepEqual((await jobs.listJobs({ search: a.client.name.toLowerCase() }, me)).items.map((x) => x.quotation_id), [a.quote.id]);
    assert.deepEqual((await jobs.listJobs({ clientId: b.client.id }, me)).items.map((x) => x.quotation_id), [b.quote.id]);
    await assert.rejects(jobs.listJobs({ state: 'BOGUS' }, me), (e) => e.status === 400);
    await assert.rejects(jobs.listJobs({ owner: 'x' }, me), (e) => e.status === 400);
  });
});

describe('listJobs queues (dashboard)', () => {
  test('each active job sits in one queue; queue filter, queue counts', async () => {
    const accepted = await job({ q: { status: 'accepted' } });
    const pricing = await job({ q: { status: 'draft' } });
    const fresh = await job({ q: { status: 'sent' } });
    const stale = await job({ q: { status: 'sent' } });
    await t.query(`UPDATE quotations SET approved_at = now() - interval '4 days' WHERE id = $1`, [stale.quote.id]);
    const expiring = await job({ q: { status: 'sent', valid_until: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) } });
    await t.query(`UPDATE quotations SET approved_at = now() WHERE id IN ($1, $2)`, [fresh.quote.id, expiring.quote.id]);
    const deposit = await job({ q: { status: 'accepted' }, o: {} });
    const soon = await job({ q: { status: 'accepted' }, o: { stage: 'in_production', due: new Date(Date.now() + 864e5).toISOString().slice(0, 10) } });
    const later = await job({ q: { status: 'accepted' }, o: { stage: 'in_production', due: '2999-01-01' } });
    const owed = await job({ q: { status: 'accepted' }, o: { stage: 'ready', payment_status: 'deposit_paid' } });
    const paid = await job({ q: { status: 'accepted' }, o: { stage: 'ready', payment_status: 'paid_in_full' } });
    const after = await job({ q: { status: 'accepted' }, o: { stage: 'completed', payment_status: 'paid_in_full' }, ticket: 'open' });

    const all = await jobs.listJobs({ limit: '200' }, null);
    const queueOf = (j) => all.items.find((r) => r.quotation_id === j.quote.id).queue;
    assert.deepEqual(
      [accepted, pricing, fresh, stale, expiring, deposit, soon, later, owed, paid, after].map(queueOf),
      ['accepted', 'pricing', null, 'follow_up', 'follow_up', 'deposit', 'due_soon', null, 'ready', null, 'after_sales'],
    );
    assert.deepEqual(
      Object.entries(all.queueCounts).filter(([, n]) => n),
      [['accepted', 1], ['pricing', 1], ['follow_up', 2], ['deposit', 1], ['due_soon', 1], ['ready', 1], ['after_sales', 1]],
    );
    const fu = await jobs.listJobs({ queue: 'follow_up' }, null);
    assert.deepEqual(fu.items.map((r) => r.quotation_id).sort(), [stale.quote.id, expiring.quote.id].sort());
    assert.equal(fu.total, 2);
    await assert.rejects(jobs.listJobs({ queue: 'nope' }, null), (e) => e.status === 400);
  });

  test('rows carry the primary action when it is one click (no inputs to fill)', async () => {
    const quoted = await job({ q: { status: 'sent' } });
    const deposit = await job({ q: { status: 'accepted' }, o: {} });
    const produce = await job({ q: { status: 'accepted' }, o: { payment_status: 'deposit_paid' } });
    const all = await jobs.listJobs({ limit: '200' }, { id: null, role: 'consultant' });
    const act = (j) => all.items.find((r) => r.quotation_id === j.quote.id).primary_action;
    assert.deepEqual(act(quoted), {
      key: 'accept_and_order', label: 'Client accepted — create order',
      endpoint: { method: 'POST', path: `/api/orders/convert-from-quotation/${quoted.quote.id}`, body: { accept: true } },
    });
    assert.equal(act(deposit), null, 'the deposit amount must be entered');
    assert.deepEqual([act(produce).key, act(produce).endpoint.path], ['start_production', `/api/orders/${produce.order.id}/advance`]);
  });
});

describe('getJob timeline', () => {
  test('job events, stage history (overrides flagged), payments, legacy proof timestamp, tickets and messages — oldest first', async () => {
    const { quote, order, client } = await job({ q: { status: 'accepted' }, o: { stage: 'in_production', payment_status: 'unpaid' } });
    const convo = await t.factory.conversation({ client_id: client.id });
    const manager = await t.factory.staff({ name: 'Mo Manager', role: 'manager' });
    await t.query(`UPDATE quotations SET created_at = now() - interval '3 days', approved_at = now() - interval '2 days' WHERE id = $1`, [quote.id]);
    await recordJobEvent(t.db.pool, { quotationId: quote.id, type: 'quotation.accepted', data: { source: 'client' } });
    await t.query(`INSERT INTO order_stage_history (order_id, stage, from_stage, created_at) VALUES ($1, 'deposit_pending', NULL, now() - interval '1 day')`, [order.id]);
    await t.query(`INSERT INTO order_stage_history (order_id, stage, from_stage, changed_by, override_reason, overridden_guards)
                   VALUES ($1, 'in_production', 'deposit_pending', $2, 'terms client', ARRAY['DEPOSIT_REQUIRED'])`, [order.id, manager.id]);
    await t.query(`UPDATE orders SET proof_sent_at = now() - interval '20 hours', proof_url = 'https://p' WHERE id = $1`, [order.id]);
    await t.query(`INSERT INTO payments (order_id, type, amount) VALUES ($1, 'deposit', 69)`, [order.id]);
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction) VALUES ($1, $2, 'hello', 'inbound')`, [convo.id, client.id]);
    await t.query(`INSERT INTO tickets (client_id, order_id, category, description, sla_due_at) VALUES ($1, $2, 'other', 'issue', now())`, [client.id, order.id]);

    const r = await jobs.getJob(quote.id, { role: 'manager' });
    const types = r.history.map((e) => e.type);
    assert.deepEqual(types.slice(0, 2), ['quotation.created', 'quotation.sent'], types.join(', '));
    for (const ty of ['quotation.accepted', 'order.created', 'proof.sent', 'stage.overridden', 'payment.recorded', 'message', 'ticket.opened']) {
      assert.ok(types.includes(ty), `${ty} in ${types.join(', ')}`);
    }
    const over = r.history.find((e) => e.type === 'stage.overridden');
    assert.deepEqual([over.actor_name, over.data.override], ['Mo Manager', { reason: 'terms client', guards: ['DEPOSIT_REQUIRED'] }]);
    assert.ok(r.history.find((e) => e.type === 'quotation.sent').data.legacy, 'synthesised from approved_at');
    const at = r.history.map((e) => new Date(e.at).getTime());
    assert.deepEqual([...at].sort((x, y) => x - y), at);
    assert.equal(r.conversation.id, convo.id);
    assert.equal(r.conversation.unread_count, 1);
    assert.equal(r.conversation.last_message.body, 'hello');
    assert.equal(r.tickets.length, 1);
    assert.equal(r.lifecycle.state, 'IN_PRODUCTION');
  });

  test('jobForOrder maps an order to its quotation; 404 when missing', async () => {
    const { quote, order } = await job({ q: { status: 'accepted' }, o: {} });
    assert.deepEqual(await jobs.jobForOrder(order.id), { orderId: order.id, quotationId: quote.id });
    await assert.rejects(jobs.jobForOrder('00000000-0000-4000-8000-000000000000'), (e) => e.status === 404);
  });
});
