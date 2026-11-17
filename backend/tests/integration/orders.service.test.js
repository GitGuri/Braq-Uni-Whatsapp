// orders service against a real Postgres: references, creation (always through
// a quotation), listing, conversion, stage advance (guards, overrides, legacy
// stages, proof gate, races), hold, assignment, materials, proofs and bot
// orders. Asserts DB state, the queued jobs and — after draining the queue —
// the WhatsApp messages the fake Graph API received.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, assertClean, withFailingTrigger, withSlowUpdate } from '../helpers/db.js';

const t = await setupTestDb();
const svc = await t.load('modules/orders/service.js');
const { HttpError } = await t.load('core/errors.js');

beforeEach(() => t.reset());
after(() => t.stop());

const uuid = () => crypto.randomUUID();
const counterValue = async () => Number((await t.one(`SELECT value FROM sequence_counters WHERE key = 'order' AND date_key = 'global'`)).value);
const setCounter = (v) => t.query(`UPDATE sequence_counters SET value = $1 WHERE key = 'order' AND date_key = 'global'`, [v]);
const orderRow = (id) => t.one('SELECT * FROM orders WHERE id = $1', [id]);
const history = (id) => t.query('SELECT * FROM order_stage_history WHERE order_id = $1 ORDER BY created_at, id', [id]).then((r) => r.rows);
const count = async (table) => (await t.one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
const ITEMS = [{ name: 'Polo', quantity: 1, unitPrice: 100 }];          // R100 + VAT = R115
const drain = () => t.drainJobs();

// ── Reference generation (global BRQ-O-XXXXX) ────────────────────────────────
describe('order reference generation (nextOrderRef via createOrder)', () => {
  for (const [value, ref] of [[1, 'BRQ-O-00001'], [42, 'BRQ-O-00042'], [99999, 'BRQ-O-99999'], [123456, 'BRQ-O-123456']]) {
    test(`counter ${value} → ${ref}`, async () => {
      const client = await t.factory.client();
      await setCounter(value - 1);
      const order = await svc.createOrder({ clientId: client.id, lineItems: ITEMS });
      assert.equal(order.reference, ref);
      assert.equal(await counterValue(), value);
      // one global counter row, never keyed by date
      assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM sequence_counters WHERE key = 'order'`)).n, 1);
    });
  }

  test('references past 99,999 keep counting with 5+ digits', async () => {
    const client = await t.factory.client();
    await setCounter(99999);
    const { reference } = await svc.createOrder({ clientId: client.id, lineItems: ITEMS });
    assert.equal(reference, 'BRQ-O-100000');
    assert.match(reference, /^BRQ-O-\d{5,}$/);
  });

  test('createOrder rejects and nothing is written when the counter update fails', async () => {
    const client = await t.factory.client();
    await withFailingTrigger(t, 'sequence_counters', async () => {
      await assert.rejects(svc.createOrder({ clientId: client.id, lineItems: ITEMS }), /simulated/);
    }, { when: "NEW.key = 'order'" });
    assert.equal(await count('orders'), 0);
    assert.equal(await count('quotations'), 0, 'the quotation made from the items rolls back too');
    assert.equal(await counterValue(), 0);
  });

  test('counter is allocated in the same transaction as the INSERT (failed insert rolls it back)', async () => {
    await setCounter(8);
    await assert.rejects(svc.createOrder({ clientId: uuid(), lineItems: ITEMS }), (e) => e.code === '23503');
    assert.equal(await counterValue(), 8, 'reference number not burned');
    assert.equal(await count('orders'), 0);
    assert.equal(await count('quotations'), 0);
    assert.equal(await count('order_stage_history'), 0);
  });
});

// ── createOrder ──────────────────────────────────────────────────────────────
describe('createOrder (always through a quotation)', () => {
  test("line items → accepted quotation + order; client's type; 60/40 split of the VAT-inclusive total; history", async () => {
    const client = await t.factory.client({ client_type: 'school' });
    const order = await svc.createOrder({ clientId: client.id, lineItems: [{ name: 'Polo', quantity: 3, unitPrice: 100, lineTotal: 1 }] });
    const row = await orderRow(order.id);
    assert.equal(row.client_type, 'school');
    assert.ok(row.quotation_id, 'every order has a quotation');
    const q = await t.one('SELECT * FROM quotations WHERE id = $1', [row.quotation_id]);
    assert.deepEqual([q.status, q.client_id, Number(q.subtotal), Number(q.total)], ['accepted', client.id, 300, 345]);
    assert.equal(q.line_items[0].lineTotal, 300, 'client lineTotal recomputed');
    assert.deepEqual([Number(row.total_amount), Number(row.deposit_amount), Number(row.balance_amount)], [345, 207, 138]);
    assert.deepEqual([row.po_number, row.assigned_staff_id, row.stage, row.payment_status], [null, null, 'deposit_pending', 'unpaid']);
    const [h] = await history(order.id);
    assert.deepEqual([h.stage, h.from_stage, h.changed_by, h.notes], ['deposit_pending', null, null, 'Order created']);
  });

  test('an accepted quotationId is converted; provided fields pass through', async () => {
    const client = await t.factory.client({ client_type: 'retail' });
    const staff = await t.factory.staff();
    const quote = await t.factory.quotation({ client_id: client.id, status: 'accepted', total: '1000.00' });
    const order = await svc.createOrder({ clientId: client.id, clientType: 'corporate', quotationId: quote.id, poNumber: 'PO1', assignedStaffId: staff.id });
    const row = await orderRow(order.id);
    assert.deepEqual([row.client_type, row.quotation_id, row.po_number, row.assigned_staff_id], ['corporate', quote.id, 'PO1', staff.id]);
    assert.deepEqual([Number(row.deposit_amount), Number(row.balance_amount), Number(row.total_amount)], [600, 400, 1000]);
    assert.equal((await history(order.id))[0].changed_by, staff.id);
  });

  test('the creating staff member owns the order by default and is recorded in history', async () => {
    const staff = await t.factory.staff();
    const client = await t.factory.client();
    const order = await svc.createOrder({ clientId: client.id, lineItems: ITEMS }, staff);
    assert.equal((await orderRow(order.id)).assigned_staff_id, staff.id);
    assert.equal((await history(order.id))[0].changed_by, staff.id);
  });

  for (const status of ['draft', 'sent', 'rejected']) {
    test(`a ${status} quotation is refused (400), nothing written`, async () => {
      const client = await t.factory.client();
      const quote = await t.factory.quotation({ client_id: client.id, status });
      await assert.rejects(svc.createOrder({ clientId: client.id, quotationId: quote.id }), (e) => e.status === 400 && e.extra?.code === 'QUOTE_NOT_ACCEPTED');
      assert.equal(await count('orders'), 0);
    });
  }

  test('neither quotationId nor line items → 400 (no more empty orders / initialStage)', async () => {
    const client = await t.factory.client();
    await assert.rejects(svc.createOrder({ clientId: client.id }), (e) => e instanceof HttpError && e.status === 400);
    await assert.rejects(svc.createOrder({ clientId: client.id, lineItems: [] }), (e) => e.status === 400);
    await assert.rejects(svc.createOrder(), (e) => e.status === 400);
    assert.equal(await count('orders'), 0);
  });

  test('a stage-history failure rolls the whole creation back (no order, no quotation)', async () => {
    const client = await t.factory.client();
    await withFailingTrigger(t, 'order_stage_history', async () => {
      await assert.rejects(svc.createOrder({ clientId: client.id, lineItems: ITEMS }), /simulated/);
    });
    assert.equal(await count('orders'), 0);
    assert.equal(await count('quotations'), 0);
  });

  test('queues exactly one deposit WhatsApp (dedupe order:<id>:deposit) and sends it when drained', async () => {
    const client = await t.factory.client({ whatsapp_number: '27820005555' });
    const order = await svc.createOrder({ clientId: client.id, lineItems: ITEMS });
    const jobs = await t.jobs('whatsapp.send');
    assert.deepEqual(jobs.map((j) => j.dedupe_key), [`order:${order.id}:deposit`]);
    assert.equal(t.wa.sent.length, 0);
    await drain();
    const texts = t.wa.texts('27820005555');
    assert.equal(texts.length, 1);
    assert.match(texts[0], /R 69\.00/);
  });
});

// ── listOrders ───────────────────────────────────────────────────────────────
describe('listOrders', () => {
  test('no filters → page 1 / limit 20, newest first, with client + staff names and lifecycle_state', async () => {
    const staff = await t.factory.staff({ name: 'Sam' });
    const client = await t.factory.client({ name: 'Ann', organisation: 'ACME' });
    const a = await t.factory.order({ client_id: client.id, assigned_staff_id: staff.id });
    await t.query(`UPDATE orders SET created_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
    const b = await t.factory.order({ client_id: client.id, stage: 'manufacturing' });
    const r = await svc.listOrders();
    assert.equal(r.page, 1);
    assert.equal(r.limit, 20);
    assert.equal(r.total, 2);
    assert.deepEqual(r.items.map((o) => o.id), [b.id, a.id]);
    assert.equal(r.items[1].client_name, 'Ann');
    assert.equal(r.items[1].organisation, 'ACME');
    assert.equal(r.items[1].staff_name, 'Sam');
    assert.deepEqual(r.items.map((o) => o.lifecycle_state), ['IN_PRODUCTION', 'AWAITING_DEPOSIT']);
  });

  test('all filters combine (stage, clientType, staffId, onHold, active, page/limit)', async () => {
    const staff = await t.factory.staff();
    const school = await t.factory.client({ client_type: 'school' });
    const match = await t.factory.order({ client_id: school.id, stage: 'ready', assigned_staff_id: staff.id, is_on_hold: true });
    await t.query(`UPDATE orders SET client_type = 'school' WHERE id = $1`, [match.id]);
    await t.factory.order({ client_id: school.id, stage: 'ready', assigned_staff_id: staff.id });                 // not on hold
    await t.factory.order({ client_id: school.id, stage: 'in_production', assigned_staff_id: staff.id, is_on_hold: true }); // other stage
    const r = await svc.listOrders({ stage: 'ready', clientType: 'school', staffId: staff.id, onHold: 'true', active: 'true', page: '1', limit: '10' });
    assert.deepEqual(r.items.map((o) => o.id), [match.id]);
    assert.equal(r.total, 1);
  });

  test('onHold / active only apply for the literal string "true"', async () => {
    await t.factory.order({ stage: 'completed' });
    await t.factory.order({ is_on_hold: false });
    const r = await svc.listOrders({ onHold: true, active: 'false' });
    assert.equal(r.total, 2);
    assert.equal((await svc.listOrders({ active: 'true' })).total, 1);
    assert.equal((await svc.listOrders({ onHold: 'true' })).total, 0);
  });

  test('page=0 is treated as page 1 (no negative OFFSET)', async () => {
    await t.factory.order();
    const r = await svc.listOrders({ page: '0' });
    assert.equal(r.page, 1);
    assert.equal(r.items.length, 1);
  });

  test('garbage / huge page & limit are clamped to sane integers (no error)', async () => {
    await t.factory.order();
    for (const [page, limit] of [['-5', '-1'], ['abc', 'abc'], ['99999999999999999999', '99999999999999999999']]) {
      const r = await svc.listOrders({ page, limit });
      assert.ok(Number.isSafeInteger(r.limit) && r.limit >= 1 && r.limit <= 200, `limit ${r.limit}`);
      assert.ok(Number.isSafeInteger(r.page) && r.page >= 1, `page ${r.page}`);
    }
  });

  test('returns { items, total, page, limit }; total counts all filtered rows, not the page', async () => {
    const client = await t.factory.client();
    for (let i = 0; i < 25; i++) await t.factory.order({ client_id: client.id, stage: 'ready' });
    await t.factory.order({ client_id: client.id, stage: 'completed' });
    const r = await svc.listOrders({ stage: 'ready', page: '2', limit: '10' });
    assert.equal(r.items.length, 10);
    assert.deepEqual({ total: r.total, page: r.page, limit: r.limit }, { total: 25, page: 2, limit: 10 });
  });

  test('stage given as an array matches any of the (string) values', async () => {
    const a = await t.factory.order({ stage: 'ready' });
    const b = await t.factory.order({ stage: 'completed' });
    await t.factory.order({ stage: 'in_production' });
    const r = await svc.listOrders({ stage: ['ready', 'completed', 5] });
    assert.deepEqual(r.items.map((o) => o.id).sort(), [a.id, b.id].sort());
  });
});

// ── getOrderById / getSizeRunSheetData ──────────────────────────────────────
describe('getOrderById', () => {
  test('404 when not found', async () => {
    await assert.rejects(svc.getOrderById(uuid()), (e) => e instanceof HttpError && e.status === 404);
  });

  test('returns order (+ quotation ref/items) + payments (newest first) + stage history (oldest first)', async () => {
    const quote = await t.factory.quotation({ reference: 'BRQ-Q-1', line_items: [{ name: 'Polo' }] });
    const order = await t.factory.order({ client_id: quote.client_id, quotation_id: quote.id });
    await t.query(`INSERT INTO payments (order_id, type, amount, created_at) VALUES ($1, 'deposit', 10, now() - interval '1 day'), ($1, 'balance', 5, now())`, [order.id]);
    await t.query(`INSERT INTO order_stage_history (order_id, stage, created_at) VALUES ($1, 'in_production', now()), ($1, 'deposit_pending', now() - interval '1 day')`, [order.id]);
    const r = await svc.getOrderById(order.id);
    assert.equal(r.order.id, order.id);
    assert.equal(r.order.quotation_reference, 'BRQ-Q-1');
    assert.deepEqual(r.order.quotation_line_items, [{ name: 'Polo' }]);
    assert.deepEqual(r.payments.map((p) => p.type), ['balance', 'deposit']);
    assert.deepEqual(r.history.map((h) => h.stage), ['deposit_pending', 'in_production']);
  });

  for (const [label, sqlValue, expected] of [
    ['array', `'[{"name":"A"}]'::jsonb`, [{ name: 'A' }]],
    ['JSON string', `to_jsonb('[{"name":"B"}]'::text)`, [{ name: 'B' }]],
    ['JSON null', `'null'::jsonb`, []],
    ['malformed JSON string', `to_jsonb('{oops'::text)`, []],
  ]) {
    test(`getSizeRunSheetData parses quotation line items: ${label}`, async () => {
      const quote = await t.factory.quotation();
      await t.query(`UPDATE quotations SET line_items = ${sqlValue} WHERE id = $1`, [quote.id]);
      const order = await t.factory.order({ client_id: quote.client_id, quotation_id: quote.id });
      const r = await svc.getSizeRunSheetData(order.id);
      assert.deepEqual(r.items, expected);
      assert.deepEqual(r.payments, []);
      assert.equal(r.order.id, order.id);
    });
  }

  test('getSizeRunSheetData: order without a quotation → no items', async () => {
    const order = await t.factory.order();
    assert.deepEqual((await svc.getSizeRunSheetData(order.id)).items, []);
  });
});

// ── convertFromQuotation ─────────────────────────────────────────────────────
describe('convertFromQuotation', () => {
  const acceptedQuote = async (o = {}) => {
    const client = o.client ?? await t.factory.client({ client_type: o.clientType ?? 'school', whatsapp_number: o.wa });
    return t.factory.quotation({ client_id: client.id, status: 'accepted', total: o.total ?? '1000.00', line_items: o.items ?? [{ name: 'Polo', quantity: 2 }] });
  };

  test('404 when quotation missing', async () => {
    await assert.rejects(svc.convertFromQuotation(uuid(), null), (e) => e.status === 404);
  });

  for (const status of ['draft', 'sent', 'rejected']) {
    test(`400 when quotation status is ${status}`, async () => {
      const q = await t.factory.quotation({ status });
      await assert.rejects(svc.convertFromQuotation(q.id, null), (e) => e.status === 400);
      assert.equal(await count('orders'), 0);
    });
  }

  test('409 when an order already exists for the quotation (no reference consumed)', async () => {
    const q = await acceptedQuote();
    await t.factory.order({ client_id: q.client_id, quotation_id: q.id });
    const before = await counterValue();
    await assert.rejects(svc.convertFromQuotation(q.id, null), (e) => e.status === 409);
    assert.equal(await counterValue(), before);
  });

  test("60/40 deposit split to the cent, client's client_type, PO number, notifies the client", async () => {
    const staff = await t.factory.staff();
    const q = await acceptedQuote({ total: '333.33', wa: '27820000000' });
    await setCounter(4);
    const order = await svc.convertFromQuotation(q.id, staff.id, { poNumber: 'PO-9' });
    assert.equal(order.reference, 'BRQ-O-00005');
    const row = await orderRow(order.id);
    assert.deepEqual(
      [row.client_type, row.quotation_id, row.po_number, row.assigned_staff_id, row.stage, row.payment_status, Number(row.deposit_amount), Number(row.balance_amount)],
      ['school', q.id, 'PO-9', staff.id, 'deposit_pending', 'unpaid', 200, 133.33]);
    assert.equal(Math.round((Number(row.deposit_amount) + Number(row.balance_amount)) * 100), 33333);
    assert.equal(Number(row.total_amount), 333.33);
    await drain();
    const texts = t.wa.texts('27820000000');
    assert.equal(texts.length, 1);
    assert.match(texts[0], /BRQ-O-00005/);
    assert.match(texts[0], /R 200\.00/);
    assert.match(texts[0], /• Polo {2}×2/);
    const [h] = await history(order.id);
    assert.deepEqual([h.stage, h.changed_by, h.notes], ['deposit_pending', staff.id, 'Order created from quotation']);
  });

  test('assignedStaffId overrides staffId; line items stored as a JSON string are parsed', async () => {
    const [s1, s2] = [await t.factory.staff(), await t.factory.staff()];
    const q = await acceptedQuote();
    await t.query(`UPDATE quotations SET line_items = to_jsonb('[{"name":"Cap","quantity":9}]'::text) WHERE id = $1`, [q.id]);
    const order = await svc.convertFromQuotation(q.id, s1.id, { assignedStaffId: s2.id });
    assert.equal((await orderRow(order.id)).assigned_staff_id, s2.id);
    await drain();
    assert.match(t.wa.texts()[0], /Cap {2}×9/);
  });

  test('no WhatsApp number → nothing queued; JSON-null line items tolerated; no staff → unassigned', async () => {
    const q = await acceptedQuote({ wa: '' });
    await t.query(`UPDATE quotations SET line_items = 'null'::jsonb WHERE id = $1`, [q.id]);
    const order = await svc.convertFromQuotation(q.id, null);
    assert.equal((await t.jobs()).length, 0);
    assert.equal((await orderRow(order.id)).assigned_staff_id, null);
  });

  test('WhatsApp failure is retried by the queue (order still created)', async () => {
    const q = await acceptedQuote();
    t.wa.failNext(1);
    const order = await svc.convertFromQuotation(q.id, null);
    assert.ok(await orderRow(order.id));
    assert.deepEqual(await drain(), { done: 0, retry: 1, dead: 0 });
  });

  test('the quote owner keeps the job when nobody else is named; the conversation id is carried over', async () => {
    const owner = await t.factory.staff();
    const q = await acceptedQuote();
    const convo = await t.factory.conversation({ client_id: q.client_id });
    await t.query('UPDATE quotations SET assigned_staff_id = $1, conversation_id = $2 WHERE id = $3', [owner.id, convo.id, q.id]);
    const order = await svc.convertFromQuotation(q.id, null);
    const row = await orderRow(order.id);
    assert.deepEqual([row.assigned_staff_id, row.conversation_id], [owner.id, convo.id]);
  });

  test('concurrent conversions: exactly one order', async () => {
    const q = await acceptedQuote();
    const results = await Promise.allSettled([svc.convertFromQuotation(q.id, null), svc.convertFromQuotation(q.id, null)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count('orders'), 1);
  });
});

// ── advanceOrderStage ────────────────────────────────────────────────────────
describe('advanceOrderStage', () => {
  const setup = async (o = {}) => {
    const client = await t.factory.client({ whatsapp_number: o.wa ?? '27821234567' });
    let quotationId = null;
    if (o.items !== undefined || o.itemsSql) {
      const q = await t.factory.quotation({ client_id: client.id, line_items: o.items ?? [] });
      if (o.itemsSql) await t.query(`UPDATE quotations SET line_items = ${o.itemsSql} WHERE id = $1`, [q.id]);
      quotationId = q.id;
    }
    return t.factory.order({
      client_id: client.id, quotation_id: quotationId, reference: o.reference ?? 'BRQ-O-00001',
      stage: o.stage ?? 'deposit_pending', is_on_hold: o.is_on_hold ?? false, proof_status: o.proof_status ?? 'none',
      deposit_amount: o.deposit_amount ?? '600.00', estimated_completion_date: o.estimated_completion_date ?? null,
      // Paid in full unless a test says otherwise: the deposit / balance guards have their own tests below.
      payment_status: o.payment_status ?? 'paid_in_full',
    });
  };

  test('404 when order missing', async () => {
    await assert.rejects(svc.advanceOrderStage(uuid(), null), (e) => e.status === 404);
  });

  test('409 HOLD when on hold (stage unchanged), not overridable even by a manager', async () => {
    const manager = await t.factory.staff({ role: 'manager' });
    const o = await setup({ is_on_hold: true });
    await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 409 && /hold/i.test(e.message) && e.extra.code === 'HOLD' && e.extra.overridable === false);
    await assert.rejects(svc.advanceOrderStage(o.id, manager, { override: { reason: 'really urgent' } }), (e) => e.status === 409 && e.extra.code === 'HOLD');
    assert.equal((await orderRow(o.id)).stage, 'deposit_pending');
  });

  test('DEPOSIT_REQUIRED: an unpaid order cannot start production (409, overridable); deposit_paid can', async () => {
    const o = await setup({ payment_status: 'unpaid' });
    await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 409 && e.extra.code === 'DEPOSIT_REQUIRED' && e.extra.overridable === true);
    assert.equal((await history(o.id)).length, 0);
    assert.equal((await t.jobs()).length, 0);
    const paid = await setup({ payment_status: 'deposit_paid', reference: 'BRQ-O-00002', wa: '27821234568' });
    assert.equal((await svc.advanceOrderStage(paid.id, null)).to, 'in_production');
  });

  test('BALANCE_DUE: ready → completed needs paid in full', async () => {
    const o = await setup({ stage: 'ready', payment_status: 'deposit_paid' });
    await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 409 && e.extra.code === 'BALANCE_DUE');
    assert.equal((await orderRow(o.id)).stage, 'ready');
  });

  test('override: consultant 403, short reason 400, manager succeeds and the override is recorded', async () => {
    const manager = await t.factory.staff({ role: 'manager' });
    const consultant = await t.factory.staff({ role: 'consultant' });
    const o = await setup({ payment_status: 'unpaid', proof_status: 'sent' });
    await assert.rejects(svc.advanceOrderStage(o.id, consultant, { override: { reason: 'client paid cash' } }), (e) => e.status === 403);
    await assert.rejects(svc.advanceOrderStage(o.id, manager, { override: { reason: 'ok' } }), (e) => e.status === 400);
    const r = await svc.advanceOrderStage(o.id, manager, { override: { reason: 'client paid cash' }, notes: 'rush' });
    assert.deepEqual([r.to, r.overridden], ['in_production', ['PROOF_PENDING', 'DEPOSIT_REQUIRED']]);
    const [h] = await history(o.id);
    assert.deepEqual([h.stage, h.from_stage, h.changed_by, h.notes, h.override_reason, h.overridden_guards],
      ['in_production', 'deposit_pending', manager.id, 'rush', 'client paid cash', ['PROOF_PENDING', 'DEPOSIT_REQUIRED']]);
  });

  test('history records from_stage on every transition; → ready stores the delivery type', async () => {
    const o = await setup({ stage: 'manufacturing' });
    await svc.advanceOrderStage(o.id, null, { deliveryType: 'delivery' });
    const [h] = await history(o.id);
    assert.deepEqual([h.from_stage, h.stage, h.override_reason, h.overridden_guards], ['manufacturing', 'ready', null, null]);
    assert.equal((await orderRow(o.id)).delivery_type, 'delivery');
  });

  test('400 when already completed (no update)', async () => {
    const o = await setup({ stage: 'completed' });
    await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 400 && /final stage/.test(e.message));
    assert.equal((await orderRow(o.id)).updated_at.getTime(), o.updated_at.getTime());
  });

  test('a legacy-stage order ("manufacturing") advances to ready', async () => {
    const staff = await t.factory.staff();
    const o = await setup({ stage: 'manufacturing' });
    const r = await svc.advanceOrderStage(o.id, staff.id);
    assert.deepEqual({ from: r.from, to: r.to }, { from: 'manufacturing', to: 'ready' });
    assert.equal((await orderRow(o.id)).stage, 'ready');
  });

  for (const [legacy, to] of [['po_received', 'in_production'], ['quality_control', 'ready'], ['packing_dispatch', 'completed']]) {
    test(`legacy stage ${legacy} advances to ${to}`, async () => {
      const o = await setup({ stage: legacy });
      assert.equal((await svc.advanceOrderStage(o.id, null)).to, to);
      assert.equal((await orderRow(o.id)).stage, to);
    });
  }

  test('unrecognised stage → 400 without touching the order', async () => {
    const o = await setup();
    // The 0006 CHECK constraint forbids unknown stages; lift it to plant a corrupt row.
    const { def } = await t.one(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'orders_stage_check'`);
    await t.query('ALTER TABLE orders DROP CONSTRAINT orders_stage_check');
    try {
      await t.query(`UPDATE orders SET stage = 'teleporting' WHERE id = $1`, [o.id]);
      await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 400 && /unrecognised stage/.test(e.message));
      assert.equal((await orderRow(o.id)).stage, 'teleporting');
    } finally {
      await t.query('DELETE FROM orders WHERE id = $1', [o.id]);
      await t.query(`ALTER TABLE orders ADD CONSTRAINT orders_stage_check ${def}`);
    }
  });

  for (const proof of ['sent', 'revision_requested']) {
    test(`proof_status=${proof} blocks deposit_pending → in_production with 409 (no side effects)`, async () => {
      const o = await setup({ proof_status: proof });
      await assert.rejects(svc.advanceOrderStage(o.id, null), (e) => e.status === 409 && /proof/i.test(e.message) && e.extra.code === 'PROOF_PENDING');
      assert.equal((await orderRow(o.id)).stage, 'deposit_pending');
      assert.equal((await history(o.id)).length, 0);
      assert.equal((await t.jobs()).length, 0);
    });
  }

  for (const proof of ['none', 'approved']) {
    test(`proof_status=${proof} may advance into production`, async () => {
      const o = await setup({ proof_status: proof });
      assert.equal((await svc.advanceOrderStage(o.id, null)).to, 'in_production');
    });
  }

  test('the UPDATE re-checks the proof gate: a proof sent while advancing wins (409, nothing changed)', async () => {
    const o = await setup();
    await withSlowUpdate(t, 'orders', `NEW.proof_status = 'sent' AND OLD.proof_status <> 'sent'`, 0.6, async () => {
      const proof = svc.updateProofStatus(o.id, 'sent');           // holds the row lock ~0.6s
      await new Promise((r) => setTimeout(r, 150));
      const advance = svc.advanceOrderStage(o.id, null);           // read sees proof 'none'; UPDATE waits, then re-checks
      await proof;
      await assert.rejects(advance, (e) => e.status === 409 && /refresh/.test(e.message) && e.extra.code === 'PROOF_PENDING');
    });
    assert.equal((await orderRow(o.id)).stage, 'deposit_pending');
    assert.equal((await t.jobs('whatsapp.send')).length, 0);
  });

  test('pending proof does not block later stages (in_production → ready)', async () => {
    const o = await setup({ stage: 'in_production', proof_status: 'sent' });
    assert.equal((await svc.advanceOrderStage(o.id, null)).to, 'ready');
  });

  test('lost race (stage changed since read) → 409, one history row, one WhatsApp', async () => {
    const o = await setup();
    await withSlowUpdate(t, 'orders', `NEW.stage <> OLD.stage`, 0.4, async () => {
      const results = await Promise.allSettled([svc.advanceOrderStage(o.id, null), svc.advanceOrderStage(o.id, null)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const lost = results.find((r) => r.status === 'rejected');
      assert.ok(lost.reason.status === 409 && /refresh/.test(lost.reason.message), lost.reason.message);
      assert.equal(lost.reason.extra.code, 'STALE');
    });
    assert.equal((await orderRow(o.id)).stage, 'in_production');
    assert.equal((await history(o.id)).length, 1);
    await drain();
    assert.equal(t.wa.sent.length, 1);
  });

  test('deposit_pending → in_production with estimatedCompletion + tracking: row, history and message', async () => {
    const staff = await t.factory.staff();
    const o = await setup({ items: [{ name: 'Polo', quantity: 3 }] });
    const r = await svc.advanceOrderStage(o.id, staff.id, { notes: 'go', estimatedCompletion: '2026-11-05', trackingNumber: 'TRK1' });
    assert.deepEqual({ from: r.from, to: r.to }, { from: 'deposit_pending', to: 'in_production' });
    const row = await orderRow(o.id);
    assert.equal(row.stage, 'in_production');
    assert.equal(row.tracking_number, 'TRK1');
    assert.equal(svc.formatDate(row.estimated_completion_date), '5 Nov 2026');
    const [h] = await history(o.id);
    assert.deepEqual([h.stage, h.changed_by, h.notes], ['in_production', staff.id, 'go']);
    await drain();
    const [msg] = t.wa.texts('27821234567');
    assert.match(msg, /In Production — Ref: BRQ-O-00001/);
    assert.match(msg, /Estimated completion: 0?5 Nov 2026/);
    assertClean(assert, msg);
  });

  test('only tracking number → tracking stored, completion date untouched', async () => {
    const o = await setup({ stage: 'in_production', estimated_completion_date: '2026-12-01' });
    await svc.advanceOrderStage(o.id, null, { trackingNumber: 'T' });
    const row = await orderRow(o.id);
    assert.equal(row.tracking_number, 'T');
    assert.equal(svc.formatDate(row.estimated_completion_date), '1 Dec 2026');
  });

  test('existing estimated_completion_date (pg DATE) is formatted, not dumped via Date#toString', async () => {
    const o = await setup({ estimated_completion_date: '2026-11-01' });
    await svc.advanceOrderStage(o.id, null);
    await drain();
    const [msg] = t.wa.texts();
    assert.doesNotMatch(msg, /GMT|Standard Time/);
    assert.match(msg, /Estimated completion: 0?1 Nov 2026/);
  });

  test('ready + deliveryType=delivery → dispatched message with tracking', async () => {
    const o = await setup({ stage: 'in_production' });
    await svc.advanceOrderStage(o.id, null, { deliveryType: 'delivery', trackingNumber: 'TRK2' });
    await drain();
    assert.match(t.wa.texts()[0], /Order Dispatched/);
    assert.match(t.wa.texts()[0], /Tracking number: TRK2/);
  });

  test('ready + collection → ready-for-collection message', async () => {
    const o = await setup({ stage: 'in_production' });
    await svc.advanceOrderStage(o.id, null, { deliveryType: 'collection' });
    await drain();
    assert.match(t.wa.texts()[0], /Ready for Collection/);
  });

  test('ready → completed sends the completion message; null notes / staff stored as null', async () => {
    const o = await setup({ stage: 'ready' });
    assert.equal((await svc.advanceOrderStage(o.id, null)).to, 'completed');
    await drain();
    assert.match(t.wa.texts()[0], /Order Complete/);
    const [h] = await history(o.id);
    assert.deepEqual([h.stage, h.changed_by, h.notes], ['completed', null, null]);
  });

  for (const [label, itemsSql] of [['JSON string', `to_jsonb('[{"name":"Hat","quantity":1}]'::text)`], ['malformed', `to_jsonb('{bad'::text)`], ['JSON null', `'null'::jsonb`]]) {
    test(`line items as ${label} still produce a message`, async () => {
      const o = await setup({ stage: 'ready', itemsSql });
      await svc.advanceOrderStage(o.id, null);
      await drain();
      assert.equal(t.wa.sent.length, 1);
    });
  }

  test('no WhatsApp number → nothing queued; a WhatsApp failure is retried, the advance stands', async () => {
    const quiet = await setup({ wa: '', reference: 'BRQ-O-00002' });
    await svc.advanceOrderStage(quiet.id, null);
    assert.equal((await t.jobs()).length, 0);

    const loud = await setup();
    t.wa.failNext(1);
    assert.equal((await svc.advanceOrderStage(loud.id, null)).to, 'in_production');
    assert.deepEqual(await drain(), { done: 0, retry: 1, dead: 0 });
    assert.equal((await orderRow(loud.id)).stage, 'in_production');
  });
});

// ── hold / assign / materials / proof ────────────────────────────────────────
describe('hold, assign, materials, proof', () => {
  const withOrder = async (o = {}) => {
    const client = await t.factory.client({ whatsapp_number: o.wa ?? '27830000001' });
    return t.factory.order({ client_id: client.id, reference: o.reference ?? 'BRQ-O-00003', is_on_hold: o.is_on_hold ?? false, hold_reason: o.hold_reason ?? null });
  };

  test('setOrderHold: 404', async () => {
    await assert.rejects(svc.setOrderHold(uuid(), { isOnHold: true }), (e) => e.status === 404);
  });

  test('setOrderHold: supplier_delay holds the order and notifies the client', async () => {
    const o = await withOrder();
    await svc.setOrderHold(o.id, { isOnHold: true, holdReason: 'supplier_delay' });
    const row = await orderRow(o.id);
    assert.deepEqual([row.is_on_hold, row.hold_reason], [true, 'supplier_delay']);
    await drain();
    assert.equal(t.wa.sent.length, 1);
    assert.match(t.wa.texts('27830000001')[0], /Order update — BRQ-O-00003/);
  });

  test('setOrderHold: other reason → no message; releasing clears the reason; hold without reason → null', async () => {
    const o = await withOrder();
    await svc.setOrderHold(o.id, { isOnHold: true, holdReason: 'client_request' });
    assert.equal((await orderRow(o.id)).hold_reason, 'client_request');
    await svc.setOrderHold(o.id, { isOnHold: false, holdReason: 'supplier_delay' });
    assert.deepEqual([(await orderRow(o.id)).is_on_hold, (await orderRow(o.id)).hold_reason], [false, null]);
    await svc.setOrderHold(o.id, { isOnHold: true });
    assert.equal((await orderRow(o.id)).hold_reason, null);
    assert.equal((await t.jobs()).length, 0);
  });

  test('setOrderHold: repeating an existing supplier_delay hold does not re-notify; prev_* not returned', async () => {
    const o = await withOrder({ is_on_hold: true, hold_reason: 'supplier_delay' });
    const order = await svc.setOrderHold(o.id, { isOnHold: true, holdReason: 'supplier_delay' });
    assert.equal((await t.jobs()).length, 0);
    assert.ok(!('prev_is_on_hold' in order) && !('prev_hold_reason' in order));
    assert.equal(order.whatsapp_number, '27830000001');
  });

  test('setOrderHold: switching an existing hold to supplier_delay notifies', async () => {
    const o = await withOrder({ is_on_hold: true, hold_reason: 'awaiting_artwork' });
    await svc.setOrderHold(o.id, { isOnHold: true, holdReason: 'supplier_delay' });
    await drain();
    assert.equal(t.wa.sent.length, 1);
  });

  test('setOrderHold: notification failure is retried, the hold stands', async () => {
    const o = await withOrder();
    t.wa.failNext(1);
    await svc.setOrderHold(o.id, { isOnHold: true, holdReason: 'supplier_delay' });
    // TEST-1: with the 10 ms test backoff the retry may already run inside the same
    // drain — assert the behaviour, not the timing: one failure retried, never dead,
    // the hold stands and the client gets the notice exactly once.
    const first = await drain();
    assert.equal(first.retry, 1);
    assert.equal(first.dead, 0);
    await t.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'`);
    await drain();
    assert.equal((await orderRow(o.id)).is_on_hold, true);
    assert.equal(t.wa.sent.length, 1, 'delivered once after the retry');
  });

  test('assignOrder: 404 and success', async () => {
    const staff = await t.factory.staff();
    await assert.rejects(svc.assignOrder(uuid(), staff.id), (e) => e.status === 404);
    const o = await withOrder();
    const r = await svc.assignOrder(o.id, staff.id);
    assert.equal(r.assigned_staff_id, staff.id);
    assert.equal((await orderRow(o.id)).assigned_staff_id, staff.id);
  });

  test('updateMaterialNotes: stores the JSON; 404', async () => {
    await assert.rejects(svc.updateMaterialNotes(uuid(), {}), (e) => e.status === 404);
    const o = await withOrder();
    await svc.updateMaterialNotes(o.id, { fabric: 'ok' });
    assert.deepEqual((await orderRow(o.id)).material_notes, { fabric: 'ok' });
  });

  test('sendProofToClient: 404; stores the proof; moves the open conversation into proof_review', async () => {
    await assert.rejects(svc.sendProofToClient(uuid(), 'https://p'), (e) => e.status === 404);
    const o = await withOrder();
    const convo = await t.factory.conversation({ client_id: o.client_id, context: { keep: 1 } });
    await svc.sendProofToClient(o.id, 'https://p', '');
    const row = await orderRow(o.id);
    assert.deepEqual([row.proof_url, row.proof_status, row.proof_notes], ['https://p', 'sent', null]);
    assert.ok(row.proof_sent_at);
    const cv = await t.one('SELECT state, context FROM conversations WHERE id = $1', [convo.id]);
    assert.equal(cv.state, 'proof_review');
    // proofReturnState: the menu state the bot returns the client to after the proof (UX round 2).
    assert.deepEqual(cv.context, { keep: 1, proofOrderId: o.id, proofReturnState: 'main_menu' });
  });

  test('sendProofToClient: sends the proof link + notes to the client over WhatsApp', async () => {
    const o = await withOrder({ reference: 'BRQ-O-00009', wa: '27830000009' });
    await svc.sendProofToClient(o.id, 'https://example.com/p.png', 'Front logo 8cm');
    await drain();
    const [msg] = t.wa.texts('27830000009');
    assert.match(msg, /Design Proof Ready — Ref: BRQ-O-00009/);
    assert.ok(msg.includes('https://example.com/p.png'));
    assert.ok(msg.includes('Front logo 8cm'));
    assertClean(assert, msg);
  });

  for (const state of ['consultant_active', 'awaiting_consultant']) {
    test(`sendProofToClient: does not hijack a conversation in ${state}`, async () => {
      const o = await withOrder();
      const convo = await t.factory.conversation({ client_id: o.client_id, state });
      await svc.sendProofToClient(o.id, 'https://p');
      assert.equal((await t.one('SELECT state FROM conversations WHERE id = $1', [convo.id])).state, state);
    });
  }

  test('sendProofToClient: no open conversation → opens one in proof_review', async () => {
    const o = await withOrder();
    await t.factory.conversation({ client_id: o.client_id, is_open: false });
    await svc.sendProofToClient(o.id, 'https://p');
    const open = (await t.query('SELECT state, context FROM conversations WHERE client_id = $1 AND is_open', [o.client_id])).rows;
    assert.equal(open.length, 1);
    assert.equal(open[0].state, 'proof_review');
    assert.deepEqual(open[0].context, { proofOrderId: o.id });
  });

  test('sendProofToClient: WhatsApp / conversation failures never undo the proof', async () => {
    const o = await withOrder();
    await t.factory.conversation({ client_id: o.client_id });
    t.wa.failNext(1);
    const r = await withFailingTrigger(t, 'conversations', () => svc.sendProofToClient(o.id, 'https://p'), { ops: 'UPDATE' });
    assert.equal(r.id, o.id);
    assert.equal((await orderRow(o.id)).proof_status, 'sent');
    assert.deepEqual(await drain(), { done: 0, retry: 1, dead: 0 });
  });

  test('updateProofStatus: validates status, 404, follows the proof machine, keeps notes when none given', async () => {
    await assert.rejects(svc.updateProofStatus(uuid(), 'bogus'), (e) => e.status === 400);
    await assert.rejects(svc.updateProofStatus(uuid(), 'approved'), (e) => e.status === 404);
    const o = await withOrder();
    await assert.rejects(svc.updateProofStatus(o.id, 'approved'), (e) => e.status === 409 && e.extra.code === 'PROOF_TRANSITION', 'no proof sent yet');
    await svc.updateProofStatus(o.id, 'sent');
    await svc.updateProofStatus(o.id, 'revision_requested', 'bigger logo');
    assert.deepEqual([(await orderRow(o.id)).proof_status, (await orderRow(o.id)).proof_notes], ['revision_requested', 'bigger logo']);
    await assert.rejects(svc.updateProofStatus(o.id, 'approved'), (e) => e.status === 409, 'changes requested → a new proof first');
    await svc.updateProofStatus(o.id, 'sent');
    await svc.updateProofStatus(o.id, 'approved');
    assert.deepEqual([(await orderRow(o.id)).proof_status, (await orderRow(o.id)).proof_notes], ['approved', 'bigger logo']);
    await svc.updateProofStatus(o.id, 'sent', 'note');
    assert.equal((await orderRow(o.id)).proof_notes, 'note');
    const events = (await t.query('SELECT type FROM job_events WHERE order_id = $1 ORDER BY id', [o.id])).rows.map((r) => r.type);
    assert.deepEqual(events, ['proof.sent', 'proof.revision_requested', 'proof.sent', 'proof.approved', 'proof.sent']);
  });

  test('an approved proof cannot be replaced once production has started', async () => {
    const o = await withOrder();
    await t.query(`UPDATE orders SET proof_status = 'approved', stage = 'in_production' WHERE id = $1`, [o.id]);
    await assert.rejects(svc.sendProofToClient(o.id, 'https://p2'), (e) => e.status === 409 && /production has started/.test(e.message));
    assert.equal((await orderRow(o.id)).proof_url, null);
  });
});

// ── Bot orders (through a quotation) ─────────────────────────────────────────
describe('placeDirectOrder / placeOrderFromQuotation (bot)', () => {
  test('direct order: accepted auto quotation keeps the line items + conversation; VAT 15%, 60% deposit, cents rounding', async () => {
    const client = await t.factory.client({ client_type: 'church' });
    const convo = await t.factory.conversation({ client_id: client.id });
    await setCounter(11);
    const items = [{ name: 'Polo', lineTotal: 100.1 }, { name: 'Cap', lineTotal: '33.33' }];
    const order = await svc.placeDirectOrder(client.id, items, { conversationId: convo.id });
    const row = await orderRow(order.id);
    // subtotal 133.43 → VAT 20.01 (20.0145) → total 153.44 → deposit 92.06 → balance 61.38
    assert.deepEqual([row.reference, Number(row.total_amount), Number(row.deposit_amount), Number(row.balance_amount), row.client_type],
      ['BRQ-O-00012', 153.44, 92.06, 61.38, 'church']);
    const q = await t.one('SELECT * FROM quotations WHERE id = $1', [row.quotation_id]);
    assert.deepEqual([q.status, q.auto_quoted, q.conversation_id, q.line_items.map((i) => i.name)], ['accepted', true, convo.id, ['Polo', 'Cap']]);
    assert.equal(row.conversation_id, convo.id);
    const [h] = await history(order.id);
    assert.deepEqual([h.stage, h.changed_by, h.notes], ['deposit_pending', null, 'Order placed via WhatsApp']);
    assert.equal((await t.jobs()).length, 0, 'the bot replies with the deposit itself — no second deposit message');
  });

  test('deposit + balance always equals total (no lost cents)', async () => {
    const client = await t.factory.client();
    for (const lt of [0.01, 1, 99.99, 333.33, 1234.56, 99999.99]) {
      const order = await svc.placeDirectOrder(client.id, [{ name: 'X', lineTotal: lt }]);
      const row = await orderRow(order.id);
      const totalCents = Math.round(lt * 100) + Math.round(Math.round(lt * 100) * 0.15);
      assert.equal(Math.round(Number(row.deposit_amount) * 100) + Math.round(Number(row.balance_amount) * 100), totalCents, `lineTotal ${lt}`);
      assert.equal(Math.round(Number(row.total_amount) * 100), totalCents);
    }
  });

  test('order from a sent quote: accepted through the machine, order created; second attempt 409', async () => {
    const quote = await t.factory.quotation({ status: 'sent', total: '115.00', valid_until: '2999-01-01' });
    const order = await svc.placeOrderFromQuotation(quote.client_id, quote.id);
    assert.equal((await t.one('SELECT status FROM quotations WHERE id = $1', [quote.id])).status, 'accepted');
    assert.equal((await orderRow(order.id)).quotation_id, quote.id);
    const events = (await t.query('SELECT type, data FROM job_events WHERE quotation_id = $1', [quote.id])).rows;
    assert.deepEqual(events.map((e) => [e.type, e.data.source]), [['quotation.accepted', 'bot_accept']]);
    await assert.rejects(svc.placeOrderFromQuotation(quote.client_id, quote.id), (e) => e.status === 409);
  });

  test("draft / rejected / expired quotes and other clients' quotes are refused (no bypass of the machine)", async () => {
    const draft = await t.factory.quotation({ status: 'draft' });
    await assert.rejects(svc.placeOrderFromQuotation(draft.client_id, draft.id), (e) => e.status === 400);
    assert.equal((await t.one('SELECT status FROM quotations WHERE id = $1', [draft.id])).status, 'draft');
    const rejected = await t.factory.quotation({ status: 'rejected' });
    await assert.rejects(svc.placeOrderFromQuotation(rejected.client_id, rejected.id), (e) => e.status === 400);
    const lapsed = await t.factory.quotation({ status: 'sent', valid_until: '2020-01-01' });
    await assert.rejects(svc.placeOrderFromQuotation(lapsed.client_id, lapsed.id), (e) => e.status === 409 && /expired/.test(e.message));
    const other = await t.factory.client();
    const mine = await t.factory.quotation({ status: 'sent', valid_until: '2999-01-01' });
    await assert.rejects(svc.placeOrderFromQuotation(other.id, mine.id), (e) => e.status === 404);
    assert.equal(await count('orders'), 0);
  });

  test('FIN-2: an ACCEPTED quote past its validity cannot be ordered from on WhatsApp (409 QUOTE_EXPIRED); staff still can', async () => {
    const stale = await t.factory.quotation({ status: 'accepted', valid_until: '2020-01-01', total: '1150.00' });
    await assert.rejects(svc.placeOrderFromQuotation(stale.client_id, stale.id), (e) => e.status === 409 && e.extra?.code === 'QUOTE_EXPIRED');
    assert.equal(await count('orders'), 0);
    const fresh = await t.factory.quotation({ status: 'accepted', valid_until: '2999-01-01', total: '1150.00' });
    const o = await svc.placeOrderFromQuotation(fresh.client_id, fresh.id);
    assert.ok(o.reference);
    const staff = await t.factory.staff({ role: 'consultant' });
    const byStaff = await svc.convertFromQuotation(stale.id, staff);
    assert.ok((byStaff.order ?? byStaff).reference, 'staff conversion keeps its rules (business decision)');
  });
});

// ── KPIs ─────────────────────────────────────────────────────────────────────
describe('getDashboardKpis', () => {
  test('counts and the needs-attention feed reflect the data', async () => {
    const client = await t.factory.client({ name: 'Kpi Co' });
    await t.factory.conversation({ client_id: client.id });
    const q = await t.factory.quotation({ client_id: client.id, status: 'draft' });
    await t.query(`UPDATE quotations SET sla_remind_at = now() + interval '1 hour' WHERE id = $1`, [q.id]);
    await t.factory.order({ client_id: client.id, stage: 'in_production' });
    await t.factory.order({ client_id: client.id, stage: 'ready', is_on_hold: true });
    await t.factory.order({ client_id: client.id, stage: 'completed' });
    await t.query(`INSERT INTO tickets (client_id, category, description, sla_due_at) VALUES ($1, 'other', 'Ticket text', now() - interval '1 hour')`, [client.id]);
    const { kpis, attention } = await svc.getDashboardKpis();
    assert.deepEqual(
      Object.fromEntries(Object.entries(kpis).map(([k, v]) => [k, Number(v)])),
      { new_enquiries: 1, quotations_awaiting_pricing: 1, active_orders: 1, open_tickets: 1, on_hold_orders: 1 });
    assert.deepEqual(attention.map((a) => a.type).sort(), ['quotation', 'ticket']);
    assert.equal(attention[0].type, 'ticket', 'overdue first');
    assert.equal(attention[0].client_name, 'Kpi Co');
  });
});
