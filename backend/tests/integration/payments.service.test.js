// payments service against a real Postgres: transactional recording with the
// order row locked, status/balance bookkeeping, client notification (queued in
// the payment's transaction, delivered by draining the job queue), listing.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, assertClean } from '../helpers/db.js';

const t = await setupTestDb();
const svc = await t.load('modules/payments/service.js');

beforeEach(() => t.reset());
after(() => t.stop());

const orderRow = (id) => t.one('SELECT * FROM orders WHERE id = $1', [id]);
const payments = (id) => t.query('SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at', [id]).then((r) => r.rows);

async function pricedOrder(o = {}) {
  const client = await t.factory.client({ whatsapp_number: o.wa ?? '27820000002' });
  return t.factory.order({
    client_id: client.id, reference: o.reference ?? 'BRQ-O-00001', quotation_id: o.quotation_id ?? null,
    payment_status: o.payment_status ?? 'unpaid',
    deposit_amount: 'deposit_amount' in o ? o.deposit_amount : '600.00',
    balance_amount: 'balance_amount' in o ? o.balance_amount : '400.00',
  });
}

describe('recordPayment', () => {
  test('404 when the order is missing → nothing stored', async () => {
    await assert.rejects(svc.recordPayment(crypto.randomUUID(), { amount: 1, type: 'deposit' }), (e) => e.status === 404);
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM payments')).n, 0);
  });

  test('stores the payment and updates status + balance together', async () => {
    const o = await pricedOrder();
    const p = await svc.recordPayment(o.id, { amount: 600, type: 'deposit', notes: 'EFT' });
    assert.equal(p.order_id, o.id);
    const [row] = await payments(o.id);
    assert.deepEqual([row.type, Number(row.amount), row.currency, row.notes], ['deposit', 600, 'ZAR', 'EFT']);
    const order = await orderRow(o.id);
    assert.deepEqual([order.payment_status, Number(order.balance_amount)], ['deposit_paid', 400]);
  });

  test('deposit + balance paid in full → paid_in_full, balance zeroed, "fully paid" message', async () => {
    const o = await pricedOrder();
    await svc.recordPayment(o.id, { amount: 1000, type: 'full' });
    const order = await orderRow(o.id);
    assert.deepEqual([order.payment_status, Number(order.balance_amount)], ['paid_in_full', 0]);
    await t.drainJobs();
    assert.match(t.wa.texts('27820000002')[0], /fully paid/);
  });

  test('paying the outstanding balance after the deposit → paid_in_full', async () => {
    const o = await pricedOrder();
    await svc.recordPayment(o.id, { amount: 600, type: 'deposit' });
    await svc.recordPayment(o.id, { type: 'balance', amount: 400, currency: 'ZAR', notes: 'EFT' });
    const order = await orderRow(o.id);
    assert.deepEqual([order.payment_status, Number(order.balance_amount)], ['paid_in_full', 0]);
    assert.equal((await payments(o.id)).length, 2);
  });

  test('overpayment → 400, nothing stored, no notification', async () => {
    const o = await pricedOrder({ payment_status: 'paid_in_full', balance_amount: '0.00' });
    await t.query(`INSERT INTO payments (order_id, type, amount) VALUES ($1, 'full', 1000)`, [o.id]);
    await assert.rejects(svc.recordPayment(o.id, { amount: 500, type: 'deposit' }), (e) => e.status === 400);
    assert.equal((await payments(o.id)).length, 1);
    assert.equal((await t.jobs('whatsapp.send')).length, 0, 'nothing queued');
  });

  test('deposit message shows the outstanding balance, never "R N/A"', async () => {
    const o = await pricedOrder();
    await svc.recordPayment(o.id, { amount: 600, type: 'deposit' });
    await t.drainJobs();
    const [msg] = t.wa.texts('27820000002');
    assertClean(assert, msg);
    assert.doesNotMatch(msg, /R N\/A/);
    assert.match(msg, /Payment received — Ref: BRQ-O-00001/);
    assert.match(msg, /deposit payment of \*R 600\.00\*/);
    assert.match(msg, /Outstanding balance: \*R 400\.00\*/);
  });

  test('partial deposit message shows the deposit still due; status stays unpaid', async () => {
    const o = await pricedOrder();
    await svc.recordPayment(o.id, { amount: 250, type: 'deposit' });
    await t.drainJobs();
    assert.match(t.wa.texts()[0], /Deposit still due: \*R 350\.00\*/);
    assertClean(assert, t.wa.texts()[0]);
    assert.equal((await orderRow(o.id)).payment_status, 'unpaid');
  });

  test('order with no amounts on record still gets a clean confirmation (currency shown)', async () => {
    const o = await pricedOrder({ deposit_amount: null, balance_amount: null });
    await svc.recordPayment(o.id, { amount: 250, type: 'deposit' });
    await t.drainJobs();
    assertClean(assert, t.wa.texts()[0]);
    assert.match(t.wa.texts()[0], /R 250\.00/);
  });

  test('FIN-9: a non-ZAR payment is refused (it would be summed into rand totals) — nothing stored', async () => {
    const o = await pricedOrder({ deposit_amount: null, balance_amount: null });
    await assert.rejects(svc.recordPayment(o.id, { amount: 250, type: 'deposit', currency: 'USD' }), (e) => e.status === 400);
    assert.equal((await payments(o.id)).length, 0);
  });

  for (const [type, status, balance] of [['full', 'paid_in_full', 0], ['deposit', 'deposit_paid', null]]) {
    test(`no total on record: type=${type} → ${status}`, async () => {
      const o = await pricedOrder({ deposit_amount: null, balance_amount: null });
      await svc.recordPayment(o.id, { type, amount: 10 });
      const order = await orderRow(o.id);
      assert.equal(order.payment_status, status);
      assert.equal(order.balance_amount === null ? null : Number(order.balance_amount), balance);
    });
  }

  test('the linked quotation total is used when the order has no amounts', async () => {
    const q = await t.factory.quotation({ status: 'accepted', total: '1000.00' });
    const o = await t.factory.order({ client_id: q.client_id, quotation_id: q.id });
    await svc.recordPayment(o.id, { type: 'deposit', amount: 100 });
    const order = await orderRow(o.id);
    assert.deepEqual([order.payment_status, Number(order.balance_amount)], ['deposit_paid', 900]);
    await assert.rejects(svc.recordPayment(o.id, { type: 'full', amount: 900.01 }), (e) => e.status === 400);
  });

  test('no WhatsApp number → no message', async () => {
    const o = await pricedOrder({ wa: '' });
    await svc.recordPayment(o.id, { amount: 1000, type: 'full' });
    assert.equal((await t.jobs('whatsapp.send')).length, 0);
    await t.drainJobs();
    assert.equal(t.wa.sent.length, 0);
  });

  test('one receipt job per payment, queued with the payment (dedupe payment:<id>), stored in the inbox', async () => {
    const o = await pricedOrder();
    const convo = await t.factory.conversation({ client_id: o.client_id });
    const p = await svc.recordPayment(o.id, { amount: 600, type: 'deposit' });
    const jobs = await t.jobs('whatsapp.send');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupe_key, `payment:${p.id}`);
    assert.equal(jobs[0].payload.to, '27820000002');
    await t.drainJobs();
    const msgs = (await t.query(`SELECT body, direction FROM messages WHERE conversation_id = $1`, [convo.id])).rows;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].direction, 'outbound');
    assert.match(msgs[0].body, /Payment received/);
  });

  test('WhatsApp failure does not undo the payment; the receipt is retried', async () => {
    const o = await pricedOrder();
    t.wa.failNext(1);
    await svc.recordPayment(o.id, { amount: 600, type: 'deposit' });
    assert.equal((await payments(o.id)).length, 1);
    assert.deepEqual(await t.drainJobs(), { done: 0, retry: 1, dead: 0 });
    const [job] = await t.jobs('whatsapp.send');
    assert.deepEqual([job.status, job.attempts], ['pending', 1]);
  });

  test('a failed payment write queues no receipt (same transaction)', async () => {
    const o = await pricedOrder();
    await assert.rejects(svc.recordPayment(o.id, { amount: 5000, type: 'deposit' }), (e) => e.status === 400);
    assert.equal((await t.jobs()).length, 0);
  });

  test('invalid amount / type → 400 and nothing stored', async () => {
    const o = await pricedOrder();
    for (const body of [{ type: 'deposit', amount: 0.001 }, { type: 'deposit', amount: -1 }, { type: 'deposit', amount: 0 },
      { type: 'x', amount: 1 }, { type: 'refund', amount: 1 }, { type: 'deposit', amount: NaN }, { type: 'deposit', amount: Infinity }]) {
      await assert.rejects(svc.recordPayment(o.id, body), (e) => e.status === 400, JSON.stringify(body));
    }
    assert.equal((await payments(o.id)).length, 0);
  });

  test('concurrent payments are applied one at a time (no double overpayment)', async () => {
    const o = await pricedOrder();
    const results = await Promise.allSettled([
      svc.recordPayment(o.id, { amount: 600, type: 'deposit' }),
      svc.recordPayment(o.id, { amount: 600, type: 'deposit' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.status, 400);
    assert.equal((await payments(o.id)).length, 1);
  });
});

describe('FIN-1 idempotency and audit', () => {
  const t_ = { withTx: async (fn) => (await t.load('core/db.js')).withTransaction(fn) };
  test('the same idempotency key twice → one payment, one receipt; the replay returns the first row', async () => {
    const o = await pricedOrder();
    const first = await t_.withTx((tx) => svc.recordPaymentTx(tx, o.id, { amount: 300, type: 'deposit', idempotencyKey: 'form-abc-123' }));
    const again = await t_.withTx((tx) => svc.recordPaymentTx(tx, o.id, { amount: 300, type: 'deposit', idempotencyKey: 'form-abc-123' }));
    assert.equal(again.replayed, true);
    assert.equal(again.payment.id, first.payment.id);
    assert.equal((await payments(o.id)).length, 1);
    await t.drainJobs();
    assert.equal(t.wa.texts('27820000002').length, 1, 'one receipt');
    assert.equal((await orderRow(o.id)).payment_status, 'unpaid', 'R300 of a R600 deposit — status unchanged by the replay');
  });

  test('concurrent submissions with one key → exactly one row (the second waits on the order lock, then replays)', async () => {
    const o = await pricedOrder();
    const results = await Promise.all([1, 2, 3].map(() =>
      t_.withTx((tx) => svc.recordPaymentTx(tx, o.id, { amount: 200, type: 'deposit', idempotencyKey: 'double-click-1' }))));
    assert.equal(new Set(results.map((r) => r.payment.id)).size, 1);
    assert.equal(results.filter((r) => r.replayed).length, 2);
    assert.equal((await payments(o.id)).length, 1);
  });

  test('a key reused with different details → 409 IDEMPOTENCY_MISMATCH, nothing new stored', async () => {
    const o = await pricedOrder();
    await svc.recordPayment(o.id, { amount: 100, type: 'deposit', idempotencyKey: 'reused-key-1' });
    await assert.rejects(svc.recordPayment(o.id, { amount: 150, type: 'deposit', idempotencyKey: 'reused-key-1' }),
      (e) => e.status === 409 && e.extra?.code === 'IDEMPOTENCY_MISMATCH');
    assert.equal((await payments(o.id)).length, 1);
  });

  test('the same key on two different orders is two payments (keys are per order)', async () => {
    const a = await pricedOrder({ wa: '27820000011', reference: 'BRQ-O-00011' });
    const b = await pricedOrder({ wa: '27820000012', reference: 'BRQ-O-00012' });
    await svc.recordPayment(a.id, { amount: 100, type: 'deposit', idempotencyKey: 'same-key-xyz' });
    await svc.recordPayment(b.id, { amount: 100, type: 'deposit', idempotencyKey: 'same-key-xyz' });
    assert.equal((await payments(a.id)).length + (await payments(b.id)).length, 2);
  });

  test('recorded_by stores the staff member; the database refuses a non-positive amount', async () => {
    const o = await pricedOrder();
    const staff = await t.factory.staff({ role: 'consultant' });
    await svc.recordPayment(o.id, { amount: 50, type: 'deposit', recordedBy: staff.id });
    assert.equal((await payments(o.id))[0].recorded_by, staff.id);
    await assert.rejects(t.query(`INSERT INTO payments (order_id, type, amount) VALUES ($1, 'deposit', 0)`, [o.id]), /payments_amount_positive/);
  });
});

describe('listing', () => {
  test('listPayments newest first; listPaymentsForOrder oldest first; scoped to the order', async () => {
    const o = await pricedOrder();
    const other = await pricedOrder({ reference: 'BRQ-O-00002', wa: '27820000003' });
    await t.query(`INSERT INTO payments (order_id, type, amount, created_at) VALUES
      ($1, 'deposit', 1, now() - interval '2 days'), ($1, 'balance', 2, now()), ($2, 'full', 3, now())`, [o.id, other.id]);
    assert.deepEqual((await svc.listPayments(o.id)).map((p) => Number(p.amount)), [2, 1]);
    assert.deepEqual((await svc.listPaymentsForOrder(o.id)).map((p) => Number(p.amount)), [1, 2]);
  });
});
