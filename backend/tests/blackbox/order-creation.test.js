/**
 * Black-box: the one order-creation path. All five entry points — staff
 * "create order" from a quote, a purchase order, the dashboard (quote id or
 * line items), the bot ordering from a quote reference and the bot's direct
 * catalog order — produce an order with quotation_id, total_amount, an exact
 * 60/40 split in cents, and exactly one deposit WhatsApp to the client.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlackbox, item, cents } from '../helpers/blackbox.js';

let bb;
let polo;
before(async () => {
  bb = await startBlackbox();
  const p = await bb.ok(bb.api('POST', '/api/products', { token: bb.admin.token, body: { category: 'corporate_wear', name: 'Polo Shirt', price: 150, sizes: ['S', 'M', 'L'] } }), 201);
  polo = p.product;
}, { timeout: 240000 });
after(async () => { await bb?.stop(); });

/** WhatsApp texts to the client that ask for the deposit on this order. */
async function depositMessages(phone, reference) {
  await bb.env.waitForJobs();
  return bb.textsTo(phone).filter((t) => t.includes(reference) && /deposit/i.test(t));
}

/** Common assertions for every entry point. */
async function assertOrder(order, { totalCents, quotationId }) {
  assert.ok(order.quotation_id, 'order has a quotation');
  if (quotationId) assert.equal(order.quotation_id, quotationId);
  const { rows: [row] } = await bb.db.query('SELECT * FROM orders WHERE id = $1', [order.id]);
  const deposit = Math.round(totalCents * 0.6);
  assert.equal(cents(row.total_amount), totalCents, 'total_amount');
  assert.equal(cents(row.deposit_amount), deposit, '60% deposit');
  assert.equal(cents(row.balance_amount), totalCents - deposit, '40% balance');
  assert.equal(cents(row.deposit_amount) + cents(row.balance_amount), totalCents, 'deposit + balance = total, to the cent');
  assert.deepEqual([row.stage, row.payment_status], ['deposit_pending', 'unpaid']);
  const { rows: [q] } = await bb.db.query('SELECT status, total FROM quotations WHERE id = $1', [row.quotation_id]);
  assert.equal(q.status, 'accepted');
  assert.equal(cents(q.total), totalCents);
  return row;
}

// R 133.33 × 3 = 399.99 + VAT 60.00 (59.9985) = 459.99 → deposit 275.99 / balance 184.00
const ODD = [item('Fleece', 3, 133.33)];
const ODD_TOTAL = 45999;

describe('every entry point funnels through the quotation', () => {
  test('staff: create order from an accepted quotation', async () => {
    const client = await bb.makeClient();
    const q = await bb.acceptedQuote(client, { lineItems: ODD });
    await bb.env.waitForJobs();
    const r = await bb.ok(bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.consultant.token, body: { poNumber: 'PO-STAFF' } }), 201);
    const row = await assertOrder(r.order, { totalCents: ODD_TOTAL, quotationId: q.id });
    assert.equal(row.po_number, 'PO-STAFF');
    assert.equal((await depositMessages(client.whatsapp_number, r.order.reference)).length, 1);

    const again = await bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: {} });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, 'ORDER_EXISTS');
    assert.equal((await depositMessages(client.whatsapp_number, r.order.reference)).length, 1, 'no second deposit message');
  });

  test('purchase order against a sent quotation (accepts it inline)', async () => {
    const client = await bb.makeClient();
    const q = await bb.sentQuote(client, { lineItems: ODD });
    const r = await bb.ok(bb.api('POST', '/api/purchase-orders', { token: bb.manager.token, body: { quotationId: q.id, poNumber: 'PO-777' } }), 201);
    const row = await assertOrder(r.order, { totalCents: ODD_TOTAL, quotationId: q.id });
    assert.equal(row.po_number, 'PO-777');
    assert.equal(r.purchaseOrder.status, 'valid');
    assert.equal((await depositMessages(client.whatsapp_number, r.order.reference)).length, 1);
    const events = (await bb.db.query('SELECT type FROM job_events WHERE quotation_id = $1 ORDER BY id', [q.id])).rows.map((e) => e.type);
    assert.deepEqual(events, ['quotation.sent', 'quotation.accepted', 'po.recorded']);
    const list = await bb.ok(bb.api('GET', '/api/purchase-orders', { token: bb.admin.token }));
    assert.ok(list.items.some((p) => p.id === r.purchaseOrder.id));
    assert.deepEqual(list.items, list.purchaseOrders);
  });

  test('dashboard: line items → accepted quotation → order', async () => {
    const client = await bb.makeClient();
    const r = await bb.ok(bb.api('POST', '/api/orders', { token: bb.consultant.token, body: { clientId: client.id, lineItems: ODD } }), 201);
    assert.equal(r.quotationId, r.order.quotation_id);
    await assertOrder(r.order, { totalCents: ODD_TOTAL });
    const { rows: [q] } = await bb.db.query('SELECT * FROM quotations WHERE id = $1', [r.order.quotation_id]);
    assert.deepEqual(q.line_items.map((i) => [i.name, i.quantity, i.lineTotal]), [['Fleece', 3, 399.99]]);
    assert.equal(r.order.assigned_staff_id, bb.consultant.id);
    assert.equal((await depositMessages(client.whatsapp_number, r.order.reference)).length, 1);
  });

  test('dashboard: an accepted quotationId; a sent one is refused; neither → 400', async () => {
    const client = await bb.makeClient();
    const q = await bb.acceptedQuote(client, { lineItems: ODD });
    const r = await bb.ok(bb.api('POST', '/api/orders', { token: bb.admin.token, body: { clientId: client.id, quotationId: q.id } }), 201);
    await assertOrder(r.order, { totalCents: ODD_TOTAL, quotationId: q.id });
    assert.equal((await depositMessages(client.whatsapp_number, r.order.reference)).length, 1);

    const sent = await bb.sentQuote(client);
    const s = await bb.api('POST', '/api/orders', { token: bb.admin.token, body: { clientId: client.id, quotationId: sent.id } });
    assert.equal(s.status, 400, s.text);
    assert.equal(s.json.code, 'QUOTE_NOT_ACCEPTED');
    const n = await bb.api('POST', '/api/orders', { token: bb.admin.token, body: { clientId: client.id } });
    assert.equal(n.status, 400, n.text);
    const legacy = await bb.api('POST', '/api/orders', { token: bb.admin.token, body: { clientId: client.id, lineItems: ODD, initialStage: 'in_production' } });
    assert.equal(legacy.status, 201, 'initialStage is ignored');
    assert.equal(legacy.json.order.stage, 'deposit_pending');
  });

  // The bot asks "collect or deliver?" before a first order — these clients already said they collect.
  const collects = (phone) => bb.db.query(`UPDATE clients SET preferred_store_location = 'Collect in store' WHERE whatsapp_number = $1`, [phone]);

  test('bot: ordering from a sent quotation (offered by the bot; accepted through the machine)', async () => {
    const phone = await bb.registeredPhone('Quote Orderer');
    await collects(phone);
    const client = await bb.clientOf(phone);
    const q = await bb.sentQuote(client, { lineItems: ODD });
    await bb.env.waitForJobs();
    let r = await bb.sendInbound(phone, '4');
    assert.ok(r.some((t) => t.includes(`order from your quote *${q.reference}*`) && t.includes('R 275.99')), r.join('|'));
    r = await bb.sendInbound(phone, '1');
    const placed = r.find((t) => t.includes('Order Placed — Ref:'));
    assert.ok(placed, r.join('|'));
    const ref = placed.match(/BRQ-O-\d{5}/)[0];
    const { rows: [order] } = await bb.db.query('SELECT * FROM orders WHERE reference = $1', [ref]);
    const row = await assertOrder(order, { totalCents: ODD_TOTAL, quotationId: q.id });
    assert.equal(row.conversation_id, (await bb.convoOf(phone)).id, 'conversation recorded on the order');
    assert.equal((await depositMessages(phone, ref)).length, 1, 'one deposit message (the bot reply), not two');
  });

  test('bot: direct catalog order keeps its line items on an auto quotation', async () => {
    const phone = await bb.registeredPhone('Direct Dineo');
    await collects(phone);
    await bb.sendInbound(phone, '4'); // no quote on file → "What would you like to order?"
    bb.env.setAiResponse({
      status: 'ready', consolidatedRequest: '10 Polo Shirts navy M',
      items: [{ productId: polo.id, quantity: 10, colour: 'Navy', sizes: [{ size: 'M', qty: 10 }] }], unmatchedText: [],
    });
    await bb.sendInbound(phone, '10 navy polos size M');
    const r = await bb.sendInbound(phone, '1');
    const placed = r.find((t) => t.includes('Order Placed — Ref:'));
    assert.ok(placed, r.join('|'));
    assert.ok(placed.includes('R 1035.00'), placed);
    const ref = placed.match(/BRQ-O-\d{5}/)[0];
    const { rows: [order] } = await bb.db.query('SELECT * FROM orders WHERE reference = $1', [ref]);
    await assertOrder(order, { totalCents: 172500 });
    const { rows: [q] } = await bb.db.query('SELECT * FROM quotations WHERE id = $1', [order.quotation_id]);
    assert.equal(q.auto_quoted, true);
    assert.equal(q.conversation_id, (await bb.convoOf(phone)).id);
    assert.deepEqual(q.line_items.map((i) => [i.productId, i.name, i.quantity, i.lineTotal, i.colour]), [[polo.id, 'Polo Shirt', 10, 1500, 'Navy']]);
    assert.equal((await depositMessages(phone, ref)).length, 1);

    // The job is visible end to end
    const job = await bb.ok(bb.api('GET', `/api/jobs/${order.quotation_id}`, { token: bb.admin.token }));
    assert.equal(job.lifecycle.state, 'AWAITING_DEPOSIT');
    assert.equal(job.order.id, order.id);
  });

  test('bot: ordering from a quote that already has an order → polite "no longer available", no duplicate', async () => {
    const phone = await bb.registeredPhone('Twice Tumi');
    const client = await bb.clientOf(phone);
    const q = await bb.acceptedQuote(client);
    await bb.ok(bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: {} }), 201);
    await bb.env.waitForJobs();
    await collects(phone);
    const offer = await bb.sendInbound(phone, '4');
    assert.ok(!offer.some((t) => t.includes(q.reference)), 'a quote that already has an order is not offered');
    const r = await bb.sendInbound(phone, q.reference);
    assert.ok(r.some((t) => t.includes('no longer available')), r.join('|'));
    const { rows } = await bb.db.query('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id = $1', [q.id]);
    assert.equal(rows[0].n, 1);
  });

  test('concurrent conversions of one quote: one order, one 409, one deposit message', async () => {
    const client = await bb.makeClient();
    const q = await bb.acceptedQuote(client);
    const results = await Promise.all([
      bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.admin.token, body: {} }),
      bb.api('POST', `/api/orders/convert-from-quotation/${q.id}`, { token: bb.manager.token, body: {} }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const ref = results.find((r) => r.status === 201).json.order.reference;
    assert.equal((await depositMessages(client.whatsapp_number, ref)).length, 1);
  });
});
