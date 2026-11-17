// Customer-side WhatsApp bot, UX round 2, against a real Postgres (fake WhatsApp /
// Gemini / Resend): one-message registration (with the WhatsApp profile name),
// the first message's intent carried through registration, companies never asked
// "which school", 24-hour stale reset, tracking list, tickets (category inference,
// photos attached), proof answers anywhere, "9" as data, consultant take-over
// message, and the 24-hour template window in the whatsapp.send worker.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, assertClean } from '../helpers/db.js';

const t = await setupTestDb({ env: { WHATSAPP_WINDOW_CHECK: 'on' } });
const bot = await t.load('modules/bot/router.js');
const conversations = await t.load('modules/conversations/service.js');
const { queueClientMessage, queueWhatsAppText, TEMPLATE_FALLBACKS } = await t.load('modules/notifications/whatsapp.js');
const handlers = (await t.load('workers/handlers/index.js')).handlers;

const PHONE = '27820000555';
let seq = 0;
const inbound = async (body, { profileName = null, id = `ux.${++seq}` } = {}) => {
  await bot.handleInbound({ phoneNumber: PHONE, metaMessageId: id, body, profileName });
  await t.drainJobs();
};
const media = async (type, payload) => {
  await bot.handleInboundMedia({ phoneNumber: PHONE, metaMessageId: `ux.m${++seq}`, type, payload });
  await t.drainJobs();
};
const replies = () => t.wa.texts(PHONE);
const lastReply = () => replies().at(-1) ?? '';
const convo = () => t.one(`SELECT cv.* FROM conversations cv JOIN clients c ON c.id = cv.client_id WHERE c.whatsapp_number = $1 AND cv.is_open`, [PHONE]);
const clientRow = () => t.one('SELECT * FROM clients WHERE whatsapp_number = $1', [PHONE]);

async function existing(state = 'main_menu', context = {}, fields = {}) {
  const { preferred_store_location: store = null, physical_address: address = null, ...rest } = fields;
  let client = await t.factory.client({ whatsapp_number: PHONE, name: 'Ann Parent', client_type: 'retail', profile_complete: true, ...rest });
  if (store || address) {
    client = await t.one('UPDATE clients SET preferred_store_location = $2, physical_address = $3 WHERE id = $1 RETURNING *', [client.id, store, address]);
  }
  const cv = await t.factory.conversation({ client_id: client.id, state, context });
  return { client, convo: cv };
}

/** The fake AI answers per kind of call (matched on the system prompt). */
function aiBy(rules) {
  t.ai.set((body) => {
    const text = JSON.stringify(body);
    for (const [needle, reply] of rules) if (text.includes(needle)) return typeof reply === 'function' ? reply(text) : reply;
    return '{}';
  });
}
const GATHER = 'quotation assistant for Braq Uni';
const PARSE = 'extract a quotation request into structured line items';
const REG = 'Extract customer details';
const ROUTE = 'Classify the customer';

let polo;
beforeEach(async () => {
  await t.reset();
  delete process.env.WHATSAPP_TEMPLATES;
  polo = await t.one(`INSERT INTO products (category, name, price, sizes) VALUES ('knitwear', 'Dalview Jersey', 200, '["8","10","12"]') RETURNING *`);
  await t.factory.staff({ role: 'consultant', email: 'pool@test.local' });
});
after(() => t.stop());

// ─────────────────────────────────────────────────────────────────────────────
describe('registration in one message', () => {
  test('profile name kept; first message intent carried through; only the school is asked; 3 messages instead of 6', async () => {
    t.ai.set((body) => {
      const text = JSON.stringify(body);
      if (text.includes(GATHER)) return { status: 'ready', consolidatedRequest: '30 Dalview Jersey size 10' };
      if (text.includes(PARSE)) return { items: [{ productId: polo.id, quantity: 30, sizes: [{ size: '10', qty: 30 }] }], unmatchedText: [] };
      return '{}';
    });
    await inbound('Hi, I need a quote for 30 Dalview jerseys', { profileName: 'thabo mokoena' });
    const c1 = await clientRow();
    assert.equal(c1.name, 'Thabo Mokoena', 'WhatsApp profile name stored (tidied)');
    // A brand-new conversation also gets the after-hours notice when the suite runs
    // outside SA business hours (Mon–Fri 08–17, Sat 08–13): count only the flow's reply.
    const flow = replies().filter((r) => !/outside (our )?(business|office|trading) hours|closed right now|we're closed|after hours/i.test(r));
    assert.equal(flow.length, 1, replies().join(' | '));
    assert.equal(lastReply(), 'To prepare your quote, please reply with your *school or company*. 📝');
    assert.equal((await convo()).context.pendingText, 'Hi, I need a quote for 30 Dalview jerseys');

    await inbound('Laerskool Dalview');
    const c2 = await clientRow();
    assert.equal(c2.school_name, 'Laerskool Dalview');
    assert.equal(c2.client_type, 'retail');
    assert.equal(c2.profile_complete, true);
    // The carried request was quoted straight away (all catalogue → instant PDF) — no "describe what you need" again
    assert.ok(!replies().some((r) => /describe what you need/.test(r)), replies().join('|'));
    const docs = t.wa.documents(PHONE);
    assert.equal(docs.length, 1);
    assert.match(docs[0].caption, /Reply \*accept\* to go ahead, \*changes\* to request edits, or \*9\* to talk to us\. Valid until \d{1,2} \w{3} \d{4}\./);
    const q = await t.one('SELECT * FROM quotations');
    assert.equal(q.status, 'sent');
    assert.equal(Number(q.total), 6900);
  });

  test('no usable profile name: name + school + collect/deliver for an order in ONE message (simple parsing)', async () => {
    await inbound('hi', { profileName: '🌸' });
    assert.equal((await clientRow()).name, null, 'an emoji profile name is not a name');
    await inbound('4');
    assert.equal(lastReply(),
      'To place your order, please reply with:\n\n1) your *full name*\n2) your *school or company*\n3) *collect* in store, or your *delivery address*\n\n' +
      '_e.g. "Thabo Mokoena, Dalview Primary, collect"_');
    await inbound('thabo mokoena, Dalpark Primary, I will collect');
    const c = await clientRow();
    assert.deepEqual([c.name, c.school_name, c.preferred_store_location, c.delivery_preference, c.profile_complete],
      ['Thabo Mokoena', 'Dalpark Primary', 'Collect in store', 'collect', true]);
    assert.match(lastReply(), /What would you like to order, \*Thabo\*\?/);
    assert.equal((await convo()).state, 'order_gathering');
  });

  test('an invalid name is re-asked alone; free-form replies go through the AI', async () => {
    await inbound('hi', { profileName: 'hi' });
    await inbound('3');
    assert.match(lastReply(), /1\) your \*full name\*\n2\) your \*school or company\*/);
    aiBy([[REG, { name: '', organisation: 'Acme Security', isSchool: false, fulfilment: 'unknown' }]]);
    await inbound('we are Acme Security, need uniforms');
    let c = await clientRow();
    assert.equal(c.organisation, 'Acme Security');
    assert.equal(c.client_type, 'corporate', 'a company answer makes the client corporate');
    assert.equal(lastReply(), 'Thanks! I still need your *full name*. 📝');
    aiBy([[REG, { name: 'Sipho Dlamini' }]]);
    await inbound('My name is Sipho Dlamini');
    c = await clientRow();
    assert.equal(c.name, 'Sipho Dlamini');
    assert.match(lastReply(), /^Thanks, \*Sipho\*! ✅[\s\S]*describe what you need a quotation for[\s\S]*golf shirts/);
    assert.equal((await convo()).state, 'quotation_ask_description');
  });

  test('bulk orders: companies are never asked "which school"; collect/deliver only at order time', async () => {
    await inbound('hi', { profileName: 'Busi Khumalo' });
    await inbound('2');
    assert.match(lastReply(), /Bulk orders — schools & companies/);
    await inbound('2'); // new uniforms / quote
    assert.equal(lastReply(), 'To prepare your quote, please reply with your *company or school* name. 📝');
    assert.doesNotMatch(lastReply(), /which school|\*school\* the uniforms/i);
    await inbound('Khumalo Logistics');
    const c = await clientRow();
    assert.deepEqual([c.organisation, c.client_type, c.school_name], ['Khumalo Logistics', 'corporate', null]);
    assert.match(lastReply(), /describe what you need a quotation for/);
    assert.ok(!replies().some((r) => /\*collect\* in store/.test(r)), 'collect / deliver is not asked for a quote');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('stale conversations and menus', () => {
  test('idle for over 24 hours → "Welcome back, <first name>" + menu; a message with an intent is acted on', async () => {
    const { client, convo: cv } = await existing('order_gathering', { orderHistory: [{ role: 'client', text: 'old' }] });
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction, created_at) VALUES ($1, $2, 'old', 'inbound', NOW() - INTERVAL '25 hours')`, [cv.id, client.id]);
    await inbound('hello');
    assert.match(lastReply(), /^Welcome back, \*Ann\* 👋[\s\S]*3️⃣  Get a quote/);
    assert.equal((await convo()).state, 'main_menu');

    // Next day again, the message itself asks for something → done directly
    await t.query(`UPDATE messages SET created_at = NOW() - INTERVAL '26 hours' WHERE conversation_id = $1`, [cv.id]);
    await t.query(`UPDATE conversations SET state = 'retail_size_ask' WHERE id = $1`, [cv.id]);
    await inbound('track my order');
    assert.match(lastReply(), /don't have any open orders/);
  });

  test('free text at the main menu: AI routes, answers, or hands a real question to a person', async () => {
    await existing();
    aiBy([[ROUTE, { type: 'answer', text: 'Yes, we sell school tracksuits.' }]]);
    await inbound('Do you sell school tracksuits?');
    assert.match(lastReply(), /^Yes, we sell school tracksuits\.\n\nAnything else\?/);
    aiBy([[ROUTE, { type: 'route', intent: 'track' }]]);
    await inbound('has my stuff shipped yet');
    assert.match(lastReply(), /don't have any open orders/);
    aiBy([[ROUTE, { type: 'escalate', reason: 'refund' }]]);
    await inbound('Can I get a refund for last year?');
    assert.match(lastReply(), /passed it to a consultant/);
    assert.equal((await convo()).state, 'awaiting_consultant');
  });

  test('a typed school name shows that school; retail price list / hours screens keep the shop numbers working', async () => {
    await existing('retail_menu');
    await inbound('dalview');
    assert.match(lastReply(), /Laerskool Dalview/);
    await inbound('3');
    assert.match(lastReply(), /Trading Hours/);
    assert.equal((await convo()).state, 'retail_hours');
    await inbound('5');
    assert.match(lastReply(), /lay-by/);
    assertClean(assert, lastReply());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tracking: open orders listed, no reference needed', () => {
  test('several orders → list with stage, due date; a number shows the detail with the amount still due', async () => {
    const { client } = await existing();
    await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00101', stage: 'in_production', payment_status: 'deposit_paid', balance_amount: 400, estimated_completion_date: '2026-11-03' });
    const ready = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00102', stage: 'ready', payment_status: 'unpaid', deposit_amount: 60 });
    await t.query(`UPDATE orders SET delivery_type = 'delivery', total_amount = 100 WHERE id = $1`, [ready.id]);
    await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00103', stage: 'completed' });
    await inbound('5');
    const list = lastReply();
    assert.match(list, /Your open orders/);
    assert.match(list, /\*BRQ-O-00101\* — In Production · due 3 Nov 2026/);
    assert.match(list, /\*BRQ-O-00102\* — Dispatched/);
    assert.doesNotMatch(list, /BRQ-O-00103/, 'completed orders are not listed');
    await inbound('1');
    assert.match(lastReply(), /Order Status — BRQ-O-00102[\s\S]*Dispatched[\s\S]*Deposit due to start production \(60%\): \*R 60\.00\* \(total R 100\.00\)/);
    await inbound('track');
    await inbound('2');
    assert.match(lastReply(), /Order Status — BRQ-O-00101[\s\S]*Balance still due: \*R 400\.00\*/);
  });

  test('one order → its status at once ("Ready for collection")', async () => {
    const { client } = await existing();
    await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00104', stage: 'ready', payment_status: 'paid_in_full' });
    await inbound('track');
    assert.match(lastReply(), /Order Status — BRQ-O-00104[\s\S]*Ready for collection[\s\S]*Paid in full/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tickets', () => {
  test('category inferred from the first (detailed) message; ticket number + response time; photos attached and staff told', async () => {
    const { client } = await existing();
    await inbound('My order arrived and 3 jerseys are torn at the seams');
    const tk = await t.one('SELECT * FROM tickets WHERE client_id = $1', [client.id]);
    assert.equal(tk.category, 'defective');
    assert.equal(tk.description, 'My order arrived and 3 jerseys are torn at the seams');
    const no = tk.id.replace(/-/g, '').slice(0, 8).toUpperCase();
    assert.match(lastReply(), new RegExp(`ticket \\*#${no}\\*[\\s\\S]*within \\*4 business hours\\*`));
    assert.equal((await convo()).state, 'awaiting_consultant');

    const emailsBefore = t.email.sent.length;
    await media('image', { id: 'MEDIA_TORN', caption: 'torn seam' });
    assert.match(lastReply(), new RegExp(`added to your ticket \\*#${no}\\*`));
    const photo = await t.one(`SELECT ticket_id, media_id FROM messages WHERE body = '[image received] torn seam'`);
    assert.deepEqual([photo.ticket_id, photo.media_id], [tk.id, 'MEDIA_TORN']);
    assert.ok(t.email.sent.slice(emailsBefore).some((e) => /Attachment from Ann Parent — ticket #/.test(e.subject)), 'staff emailed about the photo');
  });

  test('photos sent while describing the problem are linked when the ticket is logged', async () => {
    const { client } = await existing();
    await inbound('I have a complaint');
    assert.match(lastReply(), /select the category/);
    await inbound('3');
    await media('image', { id: 'M1' });
    assert.match(lastReply(), /add that to your report/);
    await inbound('two of the ten shirts were missing from the box');
    const tk = await t.one('SELECT * FROM tickets WHERE client_id = $1', [client.id]);
    assert.equal(tk.category, 'missing_item');
    assert.equal((await t.one(`SELECT ticket_id FROM messages WHERE body = '[image received]'`)).ticket_id, tk.id);
  });

  test('a photo outside any ticket (e.g. proof of payment) emails staff once per burst', async () => {
    await existing();
    await media('image', { id: 'POP' });
    await media('document', { id: 'POP2', filename: 'pop.pdf' });
    assert.equal(replies().length, 1);
    assert.match(lastReply(), /passed it to our team/);
    assert.equal(t.email.sent.filter((e) => /Attachment from/.test(e.subject)).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proof answers anywhere', () => {
  async function proofOrder(fields = {}) {
    const { client, convo: cv } = await existing('main_menu', {}, fields);
    const order = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00200', proof_status: 'sent', payment_status: 'unpaid' });
    return { client, order, cv };
  }

  test('"approve" at the main menu approves the waiting proof; deposit not yet in → wording says so', async () => {
    const { order } = await proofOrder();
    await inbound('approve');
    assert.equal((await t.one('SELECT proof_status FROM orders WHERE id = $1', [order.id])).proof_status, 'approved');
    assert.match(lastReply(), /Proof Approved — Ref: BRQ-O-00200[\s\S]*start production as soon as your deposit is received/);
  });

  test('account clients (clients.account_terms) are not told to pay a deposit first', async () => {
    const { client, order } = await proofOrder();
    await t.query('UPDATE clients SET account_terms = true WHERE id = $1', [client.id]);
    await inbound('approved');
    assert.match(lastReply(), /moving into production/);
    assert.equal((await t.one('SELECT proof_status FROM orders WHERE id = $1', [order.id])).proof_status, 'approved');
  });

  test('"looks good" asks to confirm; "yes" then approves', async () => {
    const { order } = await proofOrder();
    await inbound('looks good');
    assert.equal(lastReply(), 'Approve this design for order *BRQ-O-00200*? Reply *approve* or *changes*.');
    await inbound('yes');
    assert.equal((await t.one('SELECT proof_status FROM orders WHERE id = $1', [order.id])).proof_status, 'approved');
  });

  test('"changes: make the logo bigger" records the change in one message', async () => {
    const { order } = await proofOrder();
    await inbound('changes: make the logo bigger');
    const row = await t.one('SELECT proof_status, proof_notes FROM orders WHERE id = $1', [order.id]);
    assert.deepEqual([row.proof_status, row.proof_notes], ['revision_requested', 'make the logo bigger']);
    assert.match(lastReply(), /Revision Noted — Ref: BRQ-O-00200/);
    assert.equal((await convo()).state, 'main_menu');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('data collection: a bare "9" is data', () => {
  test('"9" answering "how many?" goes to the AI, not to a consultant; the word "consultant" still escapes', async () => {
    await existing('quotation_gathering', { quotationHistory: [{ role: 'client', text: 'jerseys' }, { role: 'bot', text: 'How many?' }], quotationFollowups: 1 });
    t.ai.set({ status: 'need_more_info', question: '1) colour  2) sizes' });
    await inbound('9');
    const cv = await convo();
    assert.equal(cv.state, 'quotation_gathering');
    assert.deepEqual(cv.context.quotationHistory.at(-2), { role: 'client', text: '9' });
    await inbound('consultant');
    assert.equal((await convo()).state, 'awaiting_consultant');
  });

  test('the AI asks at most 2 follow-ups, then the request is finalised', async () => {
    await existing();
    t.ai.set({ status: 'need_more_info', question: 'Please send: 1) colour 2) sizes' });
    await inbound('3');
    await inbound('jerseys');
    await inbound('blue');
    assert.equal(replies().filter((r) => r.startsWith('Please send:')).length, 2);
    await inbound('size 10');
    assert.match(lastReply(), /Quotation received — Ref:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('orders', () => {
  test('a sent quote is offered: "Order from BRQ-Q-…?" → yes places the order', async () => {
    const { client } = await existing('main_menu', {}, { preferred_store_location: 'Collect in store' });
    await t.factory.quotation({ client_id: client.id, reference: 'BRQ-Q-20261022-0001', status: 'sent', valid_until: '2999-01-01',
      line_items: [{ name: 'Dalview Jersey', quantity: 2, unitPrice: 50, lineTotal: 100 }], subtotal: 100, vat: 15, total: 115 });
    await inbound('4');
    assert.match(lastReply(), /order from your quote \*BRQ-Q-20261022-0001\*[\s\S]*Total: R 115\.00[\s\S]*1️⃣  Yes, place this order/);
    await inbound('yes');
    assert.match(lastReply(), /Order Placed — Ref: BRQ-O-\d{5}/);
  });

  test('items outside the catalogue turn the order into a quote request (no dead end)', async () => {
    await existing('main_menu', {}, { physical_address: '1 Main Rd' });
    t.ai.set({ status: 'ready', consolidatedRequest: '30 chef jackets', items: [], unmatchedText: ['30 chef jackets'] });
    await inbound('4');
    await inbound('30 chef jackets');
    assert.match(lastReply(), /Quotation received — Ref:[\s\S]*turned your order into a quote request[\s\S]*• 30 chef jackets/);
    assert.equal((await t.one(`SELECT status FROM quotations`)).status, 'draft');
    assert.equal((await convo()).state, 'awaiting_consultant');
  });

  test('bulk "repeat previous order" copies the last order into the order confirmation; 👍 places it', async () => {
    const { client } = await existing('corporate_menu', {}, { client_type: 'corporate', organisation: 'Acme', physical_address: '1 Main Rd' });
    const q = await t.factory.quotation({ client_id: client.id, status: 'accepted', reference: 'BRQ-Q-OLD',
      line_items: [{ productId: polo.id, name: 'Dalview Jersey', quantity: 5, unitPrice: 150, lineTotal: 750 }], subtotal: 750, vat: 112.5, total: 862.5 });
    await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00300', quotation_id: q.id, stage: 'completed' });
    await inbound('1');
    assert.match(lastReply(), /Repeat of order BRQ-O-00300[\s\S]*Dalview Jersey  ×5  — R 1000\.00/, 'priced at today\'s catalogue price');
    await inbound('👍');
    assert.match(lastReply(), /Order Placed — Ref:/);
    assert.equal((await t.one(`SELECT COUNT(*)::int AS n FROM orders WHERE client_id = $1`, [client.id])).n, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('consultant take-over and quotes', () => {
  test('take-over tells the client who is helping them (once)', async () => {
    const { convo: cv } = await existing('awaiting_consultant');
    // Recent inbound so the reply is inside the 24-hour window
    await inbound('hello?');
    const staff = await t.factory.staff({ name: 'Thabo Nkosi', email: 'thabo@test.local' });
    await conversations.takeover(cv.id, { id: staff.id, role: 'consultant' });
    await conversations.takeover(cv.id, { id: staff.id, role: 'consultant' });
    await t.drainJobs();
    assert.equal(replies().filter((r) => r === '👋 *Thabo* from Braq Uni is now helping you. Reply here any time.').length, 1);
  });

  test('"where is my quote" → status + the PDF re-sent; "changes" goes to the consultant', async () => {
    const { client } = await existing();
    await t.factory.quotation({ client_id: client.id, reference: 'BRQ-Q-20261022-0009', status: 'sent', valid_until: '2999-01-01',
      line_items: [{ name: 'X', quantity: 1, unitPrice: 100, lineTotal: 100 }], subtotal: 100, vat: 15, total: 115 });
    await inbound('where is my quote?');
    assert.equal(t.wa.documents(PHONE).length, 1, 'PDF re-sent');
    assert.match(lastReply(), /Quote BRQ-Q-20261022-0009\* — R 115\.00[\s\S]*sent the PDF again/);
    await inbound('changes');
    assert.match(lastReply(), /What would you like to change on quote \*BRQ-Q-20261022-0009\*/);
    await inbound('make it 40 jerseys please');
    assert.match(lastReply(), /passed your changes/);
    assert.ok(t.email.sent.some((e) => /Quote changes requested — Ref BRQ-Q-20261022-0009/.test(e.subject) && /make it 40 jerseys/.test(e.text)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('24-hour window: business-initiated messages', () => {
  async function lastInboundAgo(client, cv, interval) {
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction, created_at) VALUES ($1, $2, 'hi', 'inbound', NOW() - $3::interval)`, [cv.id, client.id, interval]);
  }
  const fallback = (client) => TEMPLATE_FALLBACKS.orderStage({ client, reference: 'BRQ-O-00001', status: 'Ready for collection', extra: 'Balance due: R 10.00' });

  test('inside the window → the free text', async () => {
    const { client, convo: cv } = await existing();
    await lastInboundAgo(client, cv, '2 hours');
    await queueClientMessage(t.db.pool, client, { text: 'Your order is ready', templateFallback: fallback(client), conversationId: cv.id });
    await t.drainJobs();
    assert.deepEqual(replies(), ['Your order is ready']);
  });

  test('outside the window with a configured template → the template, recorded in the inbox', async () => {
    const { client, convo: cv } = await existing();
    await lastInboundAgo(client, cv, '30 hours');
    process.env.WHATSAPP_TEMPLATES = JSON.stringify({ order_stage: 'braq_order_stage' });
    await queueClientMessage(t.db.pool, client, { text: 'Your order is ready', templateFallback: fallback(client), conversationId: cv.id, recorded: true });
    await t.drainJobs();
    assert.equal(replies().length, 0);
    const [sent] = t.wa.sent;
    assert.equal(sent.type, 'template');
    assert.equal(sent.template.name, 'braq_order_stage');
    assert.deepEqual(sent.template.components[0].parameters.map((p) => p.text), ['Ann', 'BRQ-O-00001', 'Ready for collection', 'Balance due: R 10.00']);
    const row = await t.one(`SELECT status, body FROM messages WHERE direction = 'outbound'`);
    assert.deepEqual([row.status, row.body], ['sent', 'Your order is ready']);
  });

  test('outside the window, no template configured → needs_template + staff emailed, not retried', async () => {
    const { client, convo: cv } = await existing();
    await lastInboundAgo(client, cv, '3 days');
    await queueClientMessage(t.db.pool, client, { text: 'Your order is ready', templateFallback: fallback(client), conversationId: cv.id });
    const out = await t.drainJobs();
    assert.equal(out.retry + out.dead, 0, 'not retried');
    assert.equal(t.wa.sent.length, 0);
    assert.equal((await t.one(`SELECT status FROM messages WHERE direction = 'outbound'`)).status, 'needs_template');
    assert.ok(t.email.sent.some((e) => /WhatsApp not delivered — Ann Parent/.test(e.subject) && /order_stage/.test(e.text)));
  });

  test('Meta 131047 on free text → permanent: template fallback, or needs_template without one', async () => {
    const { client, convo: cv } = await existing();
    await lastInboundAgo(client, cv, '1 hour');
    // Free text refused with 131047 — no fallback → needs_template, no retry
    const reengage = { status: 400, error: { message: 'Re-engagement message', code: 131047 } };
    t.wa.failNext(1, reengage);
    await queueWhatsAppText(t.db.pool, { to: PHONE, body: 'Staff note', clientId: client.id, conversationId: cv.id });
    let out = await t.drainJobs();
    assert.equal(out.retry + out.dead, 0);
    assert.equal((await t.one(`SELECT status FROM messages WHERE body = 'Staff note'`)).status, 'needs_template');

    // With a fallback and a configured template → the template goes out instead
    process.env.WHATSAPP_TEMPLATES = JSON.stringify({ order_stage: { name: 'braq_order_stage', language: 'en_ZA' } });
    t.wa.failNext(1, reengage);
    await queueClientMessage(t.db.pool, client, { text: 'Ready!', templateFallback: fallback(client), conversationId: cv.id });
    out = await t.drainJobs();
    assert.equal(out.retry + out.dead, 0);
    const tpl = t.wa.sent.find((m) => m.type === 'template');
    assert.deepEqual([tpl.template.name, tpl.template.language.code], ['braq_order_stage', 'en_ZA']);
  });

  test('a 131047 delivery receipt for a message with a fallback queues the template', async () => {
    const { client, convo: cv } = await existing();
    await lastInboundAgo(client, cv, '1 hour');
    process.env.WHATSAPP_TEMPLATES = JSON.stringify({ order_stage: 'braq_order_stage' });
    await queueClientMessage(t.db.pool, client, { text: 'Ready!', templateFallback: fallback(client), conversationId: cv.id });
    await t.drainJobs();
    const metaId = t.wa.sent[0].id;
    await handlers['message.status']({ metaMessageId: metaId, status: 'failed', errorCode: 131047 }, { job: { attempts: 1, max_attempts: 3 } });
    await t.drainJobs();
    assert.equal(t.wa.sent.at(-1).type, 'template');
  });
});
