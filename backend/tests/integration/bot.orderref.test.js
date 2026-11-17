// Bot inbound handling against a real Postgres (fake WhatsApp / Gemini):
// order-reference detection, same-phone order lookup, first-contact
// acknowledgements, message persistence / duplicates / races, keyword
// detection, consultant hand-over silence, media messages and proof replies.
import { describe, test, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, assertClean, withFailingTrigger } from '../helpers/db.js';

// Mock timers in some tests freeze Date; the queue uses DB time, so jobs stay due.
const t = await setupTestDb();
const bot = await t.load('modules/bot/router.js');
const { TEMPLATES } = await t.load('modules/bot/templates.js');

const PHONE = '27820000001';
let seq = 0;
// Replies go through the outbox: run the queued jobs before looking at what was sent.
const inbound = async (body, id = `in.${++seq}`) => { await bot.handleInbound({ phoneNumber: PHONE, metaMessageId: id, body }); await t.drainJobs(); };
const media = async (type, payload, id = `in.m${++seq}`) => { await bot.handleInboundMedia({ phoneNumber: PHONE, metaMessageId: id, type, payload }); await t.drainJobs(); };
const replies = () => t.wa.texts(PHONE);
const lastReply = () => replies().at(-1) ?? '';

/** The sender as an existing, registered client with an open conversation in `state`. */
async function existing(state = 'main_menu', context = {}) {
  const client = await t.factory.client({ whatsapp_number: PHONE, name: 'Ann', client_type: 'retail', profile_complete: true });
  const convo = await t.factory.conversation({ client_id: client.id, state, context });
  return { client, convo };
}
const convoState = async (id) => (await t.one('SELECT state FROM conversations WHERE id = $1', [id])).state;
const messages = (convoId) => t.query('SELECT direction, body, is_read_by_staff, meta_message_id FROM messages WHERE conversation_id = $1 ORDER BY created_at, id', [convoId]).then((r) => r.rows);

beforeEach(() => t.reset());
afterEach(() => mock.timers.reset());
after(() => t.stop());

// ── Order reference detection ────────────────────────────────────────────────
describe('order reference detection', () => {
  for (const [typed, normalised] of [
    ['BRQ-O-00042', 'BRQ-O-00042'],
    ['brq-o-00042', 'BRQ-O-00042'],
    ['  BRQ-O-00042  ', 'BRQ-O-00042'],
    ['BRQ-O-20250101-0001', 'BRQ-O-20250101-0001'],
    ['brq-q-20250101-0001', 'BRQ-Q-20250101-0001'],
    ['BRQ-O-100000', 'BRQ-O-100000'], // keeps working past BRQ-O-99999
    ['BRQ-O-000042', 'BRQ-O-000042'],
  ]) {
    test(`"${typed}" → status of the client's order ${normalised}`, async () => {
      const { client, convo } = await existing();
      await t.factory.order({ client_id: client.id, reference: normalised, stage: 'in_production' });
      await inbound(typed);
      assert.match(lastReply(), new RegExp(`Order Status — ${normalised}`));
      assert.match(lastReply(), /Current stage: \*In Production\*/);
      assert.equal(await convoState(convo.id), 'main_menu');
    });
  }

  for (const typed of ['BRQ-O-0042', 'BRQ-X-00042', 'BRQ-O-2025010-0001', 'BRQ-O-00042 please']) {
    test(`"${typed}" is not treated as a reference`, async () => {
      const { client } = await existing();
      await t.factory.order({ client_id: client.id, reference: 'BRQ-O-0042', stage: 'ready' });
      await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00042', stage: 'ready' });
      await inbound(typed);
      assert.doesNotMatch(replies().join('\n'), /Order Status —/);
    });
  }
});

// ── findOrder: only the sender's own orders ──────────────────────────────────
describe('order lookup (same-phone fallback, no disclosure)', () => {
  test('unknown reference → not-found reply', async () => {
    await existing();
    await inbound('BRQ-O-00077');
    assert.match(lastReply(), /couldn't find an order with that reference/);
  });

  test('order on another client row registered under the same phone number is shown', async () => {
    await existing();
    const dashClient = await t.factory.client({ whatsapp_number: '+27 82 000 0001', name: 'Dash Co' });
    await t.factory.order({ client_id: dashClient.id, reference: 'BRQ-O-00005', stage: 'in_production' });
    await inbound('BRQ-O-00005');
    assert.match(lastReply(), /Order Status — BRQ-O-00005/);
    assert.match(lastReply(), /Current stage: \*In Production\*/);
  });

  test('local 0… number on the other row is normalised to 27…', async () => {
    await existing();
    const local = await t.factory.client({ whatsapp_number: '0820000001' });
    await t.factory.order({ client_id: local.id, reference: 'BRQ-O-00006', stage: 'ready' });
    await inbound('BRQ-O-00006');
    assert.match(lastReply(), /Order Status — BRQ-O-00006/);
  });

  test('tracking result includes the formatted estimated date and tracking number', async () => {
    const { client } = await existing();
    const o = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00001', stage: 'ready', estimated_completion_date: '2026-11-03' });
    await t.query(`UPDATE orders SET tracking_number = 'TRK-9' WHERE id = $1`, [o.id]);
    await inbound('BRQ-O-00001');
    assert.match(lastReply(), /Estimated completion: \*3 Nov 2026\*/);
    assert.match(lastReply(), /Tracking number: \*TRK-9\*/);
    assertClean(assert, lastReply());
  });

  test("another client's order (sequential, guessable ref) is never disclosed", async () => {
    await existing();
    const other = await t.factory.client({ whatsapp_number: '27839999999', name: 'Other Co' });
    const o = await t.factory.order({ client_id: other.id, reference: 'BRQ-O-00002', stage: 'ready' });
    await t.query(`UPDATE orders SET tracking_number = 'SECRET-TRK' WHERE id = $1`, [o.id]);
    await inbound('BRQ-O-00002');
    assert.doesNotMatch(lastReply(), /SECRET-TRK|Other Co/);
    assert.match(lastReply(), /couldn't find an order with that reference/);
  });

  test('BRQ-Q ref while in order_ask_reference → quotation lookup, not order tracking', async () => {
    const { client } = await existing('order_ask_reference');
    await t.factory.order({ client_id: client.id, reference: 'BRQ-Q-20250101-0007', stage: 'ready' }); // decoy
    await inbound('BRQ-Q-20250101-0007');
    assert.match(lastReply(), /couldn't find a quotation/);
    assert.doesNotMatch(lastReply(), /Order Status/);
  });

  test('BRQ-Q ref while in order_ask_reference with a sent quotation → order confirmation', async () => {
    const { client, convo } = await existing('order_ask_reference');
    await t.factory.quotation({ client_id: client.id, reference: 'BRQ-Q-20250101-0008', status: 'sent', valid_until: '2999-01-01',
      line_items: [{ name: 'Polo', quantity: 2, lineTotal: 100 }], subtotal: 100, vat: 15, total: 115 });
    await inbound('BRQ-Q-20250101-0008');
    assert.match(lastReply(), /BRQ-Q-20250101-0008/);
    assert.match(lastReply(), /R 69\.00/, '60% deposit of R115');
    assert.equal(await convoState(convo.id), 'order_confirm_quote');
  });

  test('BRQ-Q ref outside order_ask_reference → order tracking lookup', async () => {
    const { client } = await existing();
    await t.factory.order({ client_id: client.id, reference: 'BRQ-Q-20250101-0009', stage: 'ready' });
    await inbound('BRQ-Q-20250101-0009');
    assert.match(lastReply(), /Order Status — BRQ-Q-20250101-0009/);
  });
});

// ── First contact ────────────────────────────────────────────────────────────
describe('first-contact acknowledgement (business hours / busy mode)', () => {
  const busy = (v) => t.query(`UPDATE settings SET value = $1 WHERE key = 'busy_mode'`, [v]);

  test('busy mode → high-volume notice before the menu', async () => {
    await busy('true');
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T10:00:00+02:00').getTime() });
    await inbound('hi');
    assert.match(replies()[0], /high volume of enquiries/);
    assert.match(lastReply(), /Get a quote/);
  });

  test('outside hours (Sunday) → outside-hours acknowledgement', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T10:00:00+02:00').getTime() });
    await inbound('hi');
    assert.match(replies()[0], /outside our trading hours/);
  });

  test('within hours and not busy → straight to the menu', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T10:00:00+02:00').getTime() });
    await inbound('hi');
    assert.equal(replies().length, 1);
    assert.match(replies()[0], /Get a quote/);
  });

  test('a brand-new contact gets a client row and one open conversation', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T10:00:00+02:00').getTime() });
    await inbound('hi');
    const { n } = await t.one(`SELECT COUNT(*)::int AS n FROM conversations c JOIN clients cl ON cl.id = c.client_id WHERE cl.whatsapp_number = $1 AND c.is_open`, [PHONE]);
    assert.equal(n, 1);
  });
});

// ── Persistence, duplicates, races ───────────────────────────────────────────
describe('message persistence, duplicates and conversation race', () => {
  test('inbound stored unread for staff, outbound stored read', async () => {
    const { convo } = await existing();
    await inbound('hi', 'wamid.persist');
    const rows = await messages(convo.id);
    const inRow = rows.find((m) => m.direction === 'inbound');
    assert.deepEqual([inRow.body, inRow.is_read_by_staff, inRow.meta_message_id], ['hi', false, 'wamid.persist']);
    const outRow = rows.find((m) => m.direction === 'outbound');
    assert.equal(outRow.is_read_by_staff, true);
    assert.match(outRow.body, /Get a quote/);
  });

  test('already-stored wamid (Meta retry) → skipped before any side effect', async () => {
    const { client, convo } = await existing();
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction, meta_message_id) VALUES ($1, $2, '1', 'inbound', 'wamid.dup')`, [convo.id, client.id]);
    await inbound('1', 'wamid.dup');
    assert.equal(t.wa.sent.length, 0);
    assert.equal((await messages(convo.id)).length, 1);
    assert.equal(await convoState(convo.id), 'main_menu');
  });

  test('the same wamid delivered twice concurrently → exactly one reply', async () => {
    const { convo } = await existing();
    await Promise.all([inbound('1', 'wamid.race'), inbound('1', 'wamid.race')]);
    assert.equal((await messages(convo.id)).filter((m) => m.direction === 'inbound').length, 1);
    assert.equal(new Set(t.wa.sent.map((m) => m.text?.body)).size, t.wa.sent.length, 'no duplicate replies');
    assert.ok(t.wa.sent.length >= 1);
  });

  test('two first messages at once → one conversation, one greeting', async () => {
    await t.query(`UPDATE settings SET value = 'true' WHERE key = 'busy_mode'`);
    await Promise.all([inbound('hi', 'wamid.a'), inbound('hello', 'wamid.b')]);
    const convos = (await t.query(`SELECT c.id FROM conversations c JOIN clients cl ON cl.id = c.client_id WHERE cl.whatsapp_number = $1`, [PHONE])).rows;
    assert.equal(convos.length, 1, 'one open conversation');
    assert.equal((await messages(convos[0].id)).filter((m) => m.direction === 'inbound').length, 2, 'both messages stored');
    assert.equal(replies().filter((r) => /high volume of enquiries/.test(r)).length, 1, 'greeted once');
  });

  test('database without the partial unique index → falls back to a plain insert', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T10:00:00+02:00').getTime() });
    await t.query('DROP INDEX uniq_open_conversation_per_client');
    try {
      await inbound('hi');
      assert.match(lastReply(), /Get a quote/);
    } finally {
      await t.query('CREATE UNIQUE INDEX uniq_open_conversation_per_client ON conversations(client_id) WHERE is_open = true');
    }
  });

  test('unexpected database error → the customer still gets a short apology', async () => {
    await existing();
    await withFailingTrigger(t, 'conversations', () => inbound('2'), { ops: 'UPDATE' });
    assert.match(lastReply(), /Sorry, something went wrong/);
  });
});

// ── Keywords ─────────────────────────────────────────────────────────────────
describe('keyword detection (word boundaries)', () => {
  // Not keywords → free text at the main menu: the AI (here unavailable) or "didn't catch that" with the options
  for (const text of ['Do you sell school tracksuits?', 'I need a blueprint of the logo', 'I want a brand new blazer', 'How do I go about opening a new account', 'print my invoice please', 'how many hours will it take']) {
    test(`"${text}" is not a keyword → main menu`, async () => {
      const { convo } = await existing();
      await inbound(text);
      assert.match(lastReply(), /Get a quote/);
      assert.equal(await convoState(convo.id), 'main_menu');
    });
  }

  for (const [text, re] of [
    ['Where is my order?', /don't have any open orders/],
    ['I want to track my order', /don't have any open orders/],
    ['where do I place an order', /To place your order, please reply with \*collect\*/],
    ['Are you open on Saturday?', /Trading Hours/],
    ['what are your opening hours', /Trading Hours/],
    ['do you do screen printing', /branding services/],
    ['Do you do lay-by?', /lay-by on selected items/],
  ]) {
    test(`"${text}" triggers its shortcut`, async () => {
      await existing();
      await inbound(text);
      assert.match(lastReply(), re);
    });
  }
});

// ── Consultant hand-over ─────────────────────────────────────────────────────
describe('consultant hand-over', () => {
  for (const text of ['Could you send me a quote for 20 shirts?', 'what are your hours', 'BRQ-O-00001', '3', '9', 'back']) {
    test(`consultant_active: "${text}" → stored, no reply, state kept`, async () => {
      const { convo } = await existing('consultant_active');
      await inbound(text);
      assert.equal(t.wa.sent.length, 0);
      assert.equal(await convoState(convo.id), 'consultant_active');
      const rows = await messages(convo.id);
      assert.deepEqual(rows.map((m) => [m.direction, m.body]), [['inbound', text]]);
    });
  }

  for (const text of ['Could you send me a quote for 20 shirts?', 'what are your hours', 'BRQ-O-00001', '3', 'back']) {
    test(`awaiting_consultant: "${text}" → acknowledged once with our hours, state kept`, async () => {
      const { convo } = await existing('awaiting_consultant', { ackPending: true });
      await inbound(text);
      assert.equal(replies().length, 1);
      assert.match(lastReply(), /your message is with our team[\s\S]*Mon–Fri 8:00–17:00, Sat 8:00–13:00[\s\S]*You don't need to send anything else/);
      assert.equal(await convoState(convo.id), 'awaiting_consultant');
      await inbound('anyone there?');
      assert.equal(replies().length, 1, 'not acknowledged again within 30 minutes');
    });
  }

  test('awaiting_consultant: acknowledged again after 30 minutes without a reply', async () => {
    const { client, convo } = await existing('awaiting_consultant', { ackPending: false });
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction, is_read_by_staff, created_at)
                   VALUES ($1, $2, 'earlier ack', 'outbound', true, NOW() - INTERVAL '31 minutes')`, [convo.id, client.id]);
    await inbound('hello?');
    assert.match(lastReply(), /your message is with our team/);
    await inbound('still there?');
    assert.equal(replies().length, 1);
  });

  test('awaiting_consultant: "9" → "you\'re in the queue"; "0" cancels with explicit wording', async () => {
    const { convo } = await existing('awaiting_consultant');
    await inbound('9');
    assert.match(lastReply(), /You're in the queue/);
    assert.equal(await convoState(convo.id), 'awaiting_consultant');
    await inbound('0');
    assert.match(lastReply(), /cancelled your request to talk to a person[\s\S]*Get a quote/);
    assert.equal(await convoState(convo.id), 'main_menu');
  });

  test('consultant_active: explicit "0" still returns to the main menu', async () => {
    const { convo } = await existing('consultant_active');
    await inbound('0');
    assert.match(lastReply(), /Get a quote/);
    assert.equal(await convoState(convo.id), 'main_menu');
  });
});

// ── Media ────────────────────────────────────────────────────────────────────
describe('non-text messages', () => {
  const inboundBodies = async (convoId) => (await messages(convoId)).filter((m) => m.direction === 'inbound').map((m) => m.body);

  test('image with caption → placeholder stored unread + short notice', async () => {
    const { convo } = await existing();
    await media('image', { id: 'X', caption: 'defect photo' });
    const [row] = (await messages(convo.id)).filter((m) => m.direction === 'inbound');
    assert.deepEqual([row.body, row.is_read_by_staff], ['[image received] defect photo', false]);
    assert.match(lastReply(), /I can only read text messages/);
  });

  test('document placeholder includes the file name', async () => {
    const { convo } = await existing();
    await media('document', { filename: 'PO-123.pdf' });
    assert.deepEqual(await inboundBodies(convo.id), ['[document received: PO-123.pdf]']);
  });

  test('notice not repeated when it was the last outbound message', async () => {
    const { client, convo } = await existing();
    await t.query(`INSERT INTO messages (conversation_id, client_id, body, direction, is_read_by_staff) VALUES ($1, $2, $3, 'outbound', true)`,
      [convo.id, client.id, TEMPLATES.MEDIA_RECEIVED()]);
    await media('image', {});
    assert.equal(t.wa.sent.length, 0);
  });

  test('sticker / location → stored, no reply', async () => {
    const { convo } = await existing();
    await media('sticker', {});
    await media('location', { latitude: -26.2, longitude: 28.3 });
    assert.equal(t.wa.sent.length, 0);
    assert.deepEqual(await inboundBodies(convo.id), ['[sticker received]', '[location shared: -26.2, 28.3]']);
  });

  test('during a consultant chat → stored, no reply', async () => {
    const { convo } = await existing('consultant_active');
    await media('image', {});
    assert.equal(t.wa.sent.length, 0);
    assert.equal((await messages(convo.id)).length, 1);
  });

  test('duplicate media delivery is stored once', async () => {
    const { convo } = await existing();
    await media('image', {}, 'wamid.img');
    await media('image', {}, 'wamid.img');
    assert.equal((await inboundBodies(convo.id)).length, 1);
  });
});

// ── Proof review ─────────────────────────────────────────────────────────────
describe('proof review replies', () => {
  async function proofSetup() {
    const client = await t.factory.client({ whatsapp_number: PHONE, profile_complete: true });
    const order = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00010', proof_status: 'sent' });
    await t.query(`UPDATE orders SET proof_url = 'https://x.test/p.png' WHERE id = $1`, [order.id]);
    const convo = await t.factory.conversation({ client_id: client.id, state: 'proof_review', context: { proofOrderId: order.id } });
    return { order, convo };
  }

  for (const text of ['approve', 'APPROVE', 'approved!', 'I approve the embroidery', 'Yes, I approve', 'yes approve', 'ok approved']) {
    test(`"${text}" → approved`, async () => {
      const { order, convo } = await proofSetup();
      await inbound(text);
      assert.match(lastReply(), /Proof Approved — Ref: BRQ-O-00010/);
      assert.equal((await t.one('SELECT proof_status FROM orders WHERE id = $1', [order.id])).proof_status, 'approved');
      assert.equal(await convoState(convo.id), 'main_menu');
    });
  }

  for (const text of ["I don't approve", 'not approved', 'the print is wrong']) {
    test(`"${text}" → not approved (re-prompt with the proof)`, async () => {
      const { order } = await proofSetup();
      await inbound(text);
      assert.doesNotMatch(lastReply(), /Proof Approved/);
      assert.equal((await t.one('SELECT proof_status FROM orders WHERE id = $1', [order.id])).proof_status, 'sent');
    });
  }

  test('"revise" → asks what to change, then records the revision request', async () => {
    const { order, convo } = await proofSetup();
    await inbound('revise');
    assert.equal(await convoState(convo.id), 'proof_revision_describe');
    await inbound('Please make the logo bigger');
    const row = await t.one('SELECT proof_status, proof_notes FROM orders WHERE id = $1', [order.id]);
    assert.deepEqual([row.proof_status, row.proof_notes], ['revision_requested', 'Please make the logo bigger']);
  });
});

// ── Accepting a quotation (lifecycle rule) ───────────────────────────────────
describe('client accepts a quotation', () => {
  const sentQuote = (clientId, reference) => t.factory.quotation({ client_id: clientId, status: 'sent', valid_until: '2999-01-01', reference });
  const status = async (id) => (await t.one('SELECT status FROM quotations WHERE id = $1', [id])).status;

  test('"accept" while waiting for a consultant accepts the sent quote; the chat keeps waiting', async () => {
    const { client, convo } = await existing('awaiting_consultant');
    const q = await sentQuote(client.id, 'BRQ-Q-20261021-0101');
    await inbound('accept');
    assert.match(lastReply(), /Quotation Accepted — Ref: BRQ-Q-20261021-0101/);
    assert.equal(await status(q.id), 'accepted');
    assert.equal(await convoState(convo.id), 'awaiting_consultant');
  });

  test('"accept BRQ-Q-…" accepts that quotation, even when it is not the latest', async () => {
    const { client } = await existing();
    const older = await sentQuote(client.id, 'BRQ-Q-20261021-0201');
    const newer = await sentQuote(client.id, 'BRQ-Q-20261021-0202');
    await inbound('Accept brq-q-20261021-0201');
    assert.match(lastReply(), /Quotation Accepted — Ref: BRQ-Q-20261021-0201/);
    assert.deepEqual([await status(older.id), await status(newer.id)], ['accepted', 'sent']);
  });

  test('owner decision 1: "accept" during an active consultant chat accepts the quote, creates no order and emails staff', async () => {
    const { client, convo } = await existing('consultant_active');
    await t.factory.staff({ role: 'consultant', email: 'pool@test.local' });
    const q = await sentQuote(client.id, 'BRQ-Q-20261021-0301');
    await inbound('I accept');
    assert.equal(await status(q.id), 'accepted');
    assert.equal(replies().length, 1);
    assert.match(lastReply(), /Quotation Accepted — Ref: BRQ-Q-20261021-0301[\s\S]*Thanks! Your consultant will confirm your order and send the deposit details shortly\./);
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM orders WHERE quotation_id = $1', [q.id])).n, 0, 'no order created');
    assert.equal(await convoState(convo.id), 'consultant_active', 'the consultant keeps the chat');
    assert.ok(t.email.sent.some((e) => /Quotation Accepted — Ref BRQ-Q-20261021-0301/.test(e.subject)), 'staff emailed');
  });

  test('"accept the quote" accepts — it is not a request for a new quote', async () => {
    const { client, convo } = await existing();
    const q = await sentQuote(client.id, 'BRQ-Q-20261021-0501');
    await inbound('Yes, I accept the quote');
    assert.equal(await status(q.id), 'accepted');
    assert.match(lastReply(), /Quotation Accepted — Ref: BRQ-Q-20261021-0501/);
    assert.equal(await convoState(convo.id), 'main_menu');
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM quotations')).n, 1, 'no new quote started');
  });

  test('a quote reference that is not the client\'s, or expired, is not accepted', async () => {
    const { client } = await existing();
    const other = await t.factory.client({ whatsapp_number: '27839990001' });
    const theirs = await sentQuote(other.id, 'BRQ-Q-20261021-0401');
    await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2020-01-01', reference: 'BRQ-Q-20261021-0402' });
    await inbound('accept BRQ-Q-20261021-0401');
    assert.match(lastReply(), /couldn't find an open quotation to accept/);
    // Expired → offer a refresh at today's prices ("1" → staff are asked to revise it)
    await t.factory.staff({ role: 'consultant', email: 'pool@test.local' });
    await inbound('accept BRQ-Q-20261021-0402');
    assert.match(lastReply(), /Quote \*BRQ-Q-20261021-0402\* expired on 1 Jan 2020\.\n\nReply \*1\* and we'll refresh it at today's prices\./);
    assert.equal(await status(theirs.id), 'sent');
    await inbound('1');
    assert.match(lastReply(), /asked your consultant to refresh quote \*BRQ-Q-20261021-0402\*/);
    assert.ok(t.email.sent.some((e) => /Refresh expired quote — Ref BRQ-Q-20261021-0402/.test(e.subject)));
  });
});
