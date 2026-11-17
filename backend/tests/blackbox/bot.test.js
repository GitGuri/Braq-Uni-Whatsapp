/**
 * Black-box tests of the WhatsApp bot (part 1): menus, navigation, input
 * handling, AI size FAQ, quotation flow, make-order flow, order tracking,
 * tickets. Driven exactly like Meta: POST /webhook payloads in, observe the
 * faked WhatsApp Graph calls out.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { startTestEnv, ADMIN } from '../helpers/env.js';

// ── local helpers ────────────────────────────────────────────────────────────
let env, db, token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newPhone = () => `2771${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const wamid = () => `wamid.TEST_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

function textPayload(from, body, id = wamid()) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '27110000000', phone_number_id: '000000' },
          contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
        },
      }],
    }],
  };
}

// Meta signs every webhook POST: X-Hub-Signature-256 = HMAC-SHA256(raw body, app secret).
// The test env runs with META_APP_SECRET='fake'.
const signBody = (raw) => `sha256=${crypto.createHmac('sha256', 'fake').update(raw).digest('hex')}`;

async function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  const r = await fetch(`${env.baseUrl}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw,
  });
  await r.text();
  return r.status;
}

const outbound = (phone) => env.fakeCalls('whatsapp').filter((c) => c.body?.to === phone);
const render = (c) => (c.body?.type === 'document'
  ? `[document:${c.body.document?.filename}] ${c.body.document?.caption ?? ''}`
  : c.body?.text?.body ?? JSON.stringify(c.body));

async function waitForReplies(phone, before, { timeout = 10000, settle = 700 } = {}) {
  const deadline = Date.now() + timeout;
  while (outbound(phone).length <= before) {
    if (Date.now() > deadline) {
      throw new Error(`No WhatsApp reply to ${phone} within ${timeout}ms. Server log tail:\n${env.logs.slice(-6).join('')}`);
    }
    await sleep(100);
  }
  let n = outbound(phone).length;
  for (;;) {
    await sleep(settle);
    const m = outbound(phone).length;
    if (m === n) break;
    n = m;
  }
  return outbound(phone).slice(before).map(render);
}

/** POST an inbound text and return the bodies of all new outbound messages to that phone. */
async function sendInbound(phone, text, opts = {}) {
  const before = outbound(phone).length;
  assert.equal(await postWebhook(textPayload(phone, text, opts.id)), 200);
  return waitForReplies(phone, before, opts);
}

/** POST an inbound text that should produce NO reply; waits until it is persisted (or 4s), then a grace period. */
async function sendExpectSilence(phone, text, { id = wamid(), grace = 1500 } = {}) {
  const before = outbound(phone).length;
  assert.equal(await postWebhook(textPayload(phone, text, id)), 200);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows } = await db.query('SELECT 1 FROM messages WHERE meta_message_id = $1', [id]);
    if (rows.length) break;
    await sleep(100);
  }
  await sleep(grace);
  return outbound(phone).slice(before).map(render);
}

async function api(method, path, body) {
  const r = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

async function convoOf(phone) {
  const { rows } = await db.query(
    `SELECT cv.* FROM conversations cv JOIN clients c ON c.id = cv.client_id
     WHERE c.whatsapp_number = $1 AND cv.is_open = true ORDER BY cv.created_at DESC LIMIT 1`, [phone]);
  return rows[0];
}
async function clientOf(phone) {
  const { rows } = await db.query('SELECT * FROM clients WHERE whatsapp_number = $1', [phone]);
  return rows[0];
}
const stateOf = async (phone) => (await convoOf(phone))?.state;

/** New client who has already chatted once and has a completed profile. */
async function registeredClient(name = 'Reg Client') {
  const phone = newPhone();
  await sendInbound(phone, 'hi');
  await db.query('UPDATE clients SET name = $2, profile_complete = true WHERE whatsapp_number = $1', [phone, name]);
  return phone;
}

async function waitForEmail(pred, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = env.fakeCalls('resend').find((c) => pred(c.body || {}));
    if (hit) return hit.body;
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}
const emailsMatching = (pred) => env.fakeCalls('resend').filter((c) => pred(c.body || {}));
const last = (arr) => arr[arr.length - 1];
const has = (arr, s) => arr.some((t) => t.includes(s));

// Distinctive substrings of the templates (UX round 2 wording)
const T = {
  MAIN_MENU: '3️⃣  Get a quote',
  RETAIL_MENU: 'Braq Uni Shop — school uniforms',
  CORPORATE_MENU: 'bulk order enquiry',
  QUOTE_ASK: 'Please describe what you need a quotation for',
  REG_ASK: 'please reply with',
  ORDER_OFFER: 'Would you like to order from your quote',
  ORDER_ASK_ITEMS: 'What would you like to order',
  TRACK_NONE: "You don't have any open orders",
  BRANDING: 'We offer the following branding services',
  STORE: 'Braq Uni — Store Information',
  HOURS: 'Braq Uni — Trading Hours',
  LAYBY: 'We offer lay-by on selected items',
  CONSULTANT: 'A consultant will reply here',
  UNKNOWN: "I didn't quite catch that",
  NOT_AN_OPTION: "that's not one of the options",
  ORDER_NOT_FOUND: "We couldn't find an order with that reference number",
  TICKET_CAT: 'Please select the category that best fits',
  TICKET_DESC: 'Please describe what happened',
  TICKET_BRIEF: 'That description is a bit brief',
  TICKET_LOGGED: 'Your issue has been logged',
  SIZE_ASK: 'Size Availability',
  SCHOOL_SELECT: 'School Uniform Information',
  PRODUCT_LIST: 'Braq Uni — Product Pricing',
  ACCOUNT_ASK: 'What is your account query about',
  ACCOUNT_LOGGED: 'Your account query has been logged',
  NO_PREVIOUS_ORDER: "couldn't find a previous order on your account",
  DRAFT_ACK: 'Quotation received — Ref:',
  ORDER_TO_QUOTE: 'turned your order into a quote request',
  QUOTE_ACCEPTED: 'Quotation Accepted — Ref:',
  NO_PENDING_QUOTE: "couldn't find an open quotation to accept",
  CONFIRM_DIRECT: 'Your Order Summary',
  CONFIRM_QUOTE: '📋 *Quotation: ',
  ORDER_CREATED: 'Order Placed — Ref:',
  QUOTE_NOT_FOUND: "couldn't find a quotation with that reference on your account",
  QUOTE_NOT_READY: 'still being reviewed by our team',
};

let polo; // catalog product

before(async () => {
  env = await startTestEnv();
  db = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false }, max: 4 });
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  token = (await r.json()).token;
  assert.ok(token, 'admin login failed');
  const p = await api('POST', '/api/products', { category: 'corporate_wear', name: 'Polo Shirt', price: 150, sizes: ['S', 'M', 'L', 'XL'] });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  polo = p.body.product;
  // Notifications are only emailed to active consultants — seed one.
  await db.query(`INSERT INTO staff (name, email, password_hash, role) VALUES ('Connie Consultant', 'consultant@test.local', 'x', 'consultant')`);
}, { timeout: 240000 });

after(async () => { await db?.end().catch(() => {}); await env?.stop(); });

/** A registered client who also told us they collect in store (so ordering needs no extra question). */
async function orderingClient(name) {
  const phone = await registeredClient(name);
  await db.query(`UPDATE clients SET preferred_store_location = 'Collect in store' WHERE whatsapp_number = $1`, [phone]);
  return phone;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('greeting, main menu and input handling', () => {
  test('new contact gets the main menu (greeted by the WhatsApp profile name); client + conversation are created', async () => {
    const phone = newPhone();
    const replies = await sendInbound(phone, 'Hello there');
    assert.ok(has(replies, T.MAIN_MENU), replies.join('\n---\n'));
    assert.ok(has(replies, 'Hi *Test* 👋'), 'greeted by first name');
    const client = await clientOf(phone);
    assert.equal(client.client_type, 'retail');
    assert.equal(client.name, 'Test User', 'WhatsApp profile name kept as the client name');
    assert.match(client.customer_number, /^C-\d{4}$/);
    assert.equal(client.profile_complete, false);
    assert.equal(await stateOf(phone), 'main_menu');
  });

  test('every main menu option 1-9 routes to the right screen/state (8 still reaches a person)', async () => {
    const phone = await registeredClient('Menu Tester');
    const expect = {
      1: [T.RETAIL_MENU, 'retail_menu'],
      2: [T.CORPORATE_MENU, 'corporate_menu'],
      3: [T.QUOTE_ASK, 'quotation_ask_description'],
      4: ['To place your order, please reply with *collect* in store', 'registration_name'],
      5: [T.TRACK_NONE, 'main_menu'],
      6: [T.TICKET_CAT, 'ticket_ask_category'],
      7: [T.STORE, 'main_menu'],
      8: [T.CONSULTANT, 'awaiting_consultant'],
      9: [T.CONSULTANT, 'awaiting_consultant'],
    };
    for (const [opt, [text, state]] of Object.entries(expect)) {
      assert.ok(has(await sendInbound(phone, '0'), T.MAIN_MENU));
      const replies = await sendInbound(phone, opt);
      assert.equal(replies.length, 1, `option ${opt}: ${replies.join('|')}`);
      assert.ok(replies[0].includes(text), `option ${opt} replied: ${replies[0]}`);
      assert.equal(await stateOf(phone), state, `option ${opt}`);
    }
  });

  test('unregistered client choosing 3 or 4 is asked — in one message — only for what is missing', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    let r = await sendInbound(phone, '3');
    assert.deepEqual(r, ['To prepare your quote, please reply with your *school or company*. 📝'], 'name known from the WhatsApp profile');
    let c = await convoOf(phone);
    assert.equal(c.state, 'registration_name');
    assert.equal(c.context.pendingIntent, 'quote');
    await sendInbound(phone, '0');
    r = await sendInbound(phone, '4');
    assert.ok(has(r, 'To place your order, please reply with:\n\n1) your *school or company*\n2) *collect* in store, or your *delivery address*'), r.join('|'));
    c = await convoOf(phone);
    assert.equal(c.context.pendingIntent, 'order');
  });

  test('"9" reaches a person from a menu; inside data collection only the word "consultant" does', async () => {
    const phone = await registeredClient();
    const r = await sendInbound(phone, '9');
    assert.ok(has(r, T.CONSULTANT));
    assert.ok(has(r, 'Mon–Fri 8:00–17:00, Sat 8:00–13:00'), 'hours / ETA stated');
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    const mail = await waitForEmail((b) => String(b.subject).includes('wants to speak to a consultant') && String(b.subject).includes('Reg Client'));
    assert.ok(mail, 'consultant email not sent');

    await sendInbound(phone, '0');
    await sendInbound(phone, '3');
    env.setAiResponse({ status: 'need_more_info', question: 'How many shirts do you need?' });
    await sendInbound(phone, 'golf shirts');
    assert.deepEqual(await sendInbound(phone, '9'), ['How many shirts do you need?'], '"9" answers the question');
    assert.equal(await stateOf(phone), 'quotation_gathering');
    assert.ok(has(await sendInbound(phone, 'agent'), T.CONSULTANT));
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    env.setAiResponse({});
  });

  test('invalid option / gibberish / emoji / very long text → "didn\'t catch that" with the menu options', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    for (const input of ['99', '42', 'asdkjh qwe zzz', '👍🏽🔥🙏', 'x'.repeat(4096), '-1', '1.5']) {
      const r = await sendInbound(phone, input);
      assert.equal(r.length, 1, `${input.slice(0, 20)} → ${r.join('|')}`);
      assert.ok(r[0].includes(T.UNKNOWN) && r[0].includes(T.MAIN_MENU), `${input.slice(0, 20)} → ${r[0].slice(0, 80)}`);
      assert.equal(await stateOf(phone), 'main_menu');
    }
    const { rows } = await db.query(
      `SELECT length(body) AS len FROM messages m JOIN clients c ON c.id = m.client_id
       WHERE c.whatsapp_number = $1 AND direction = 'inbound' ORDER BY length(body) DESC LIMIT 1`, [phone]);
    assert.equal(rows[0].len, 4096, 'very long inbound message must be stored intact');
  });

  test('whitespace-only message is ignored without a reply or crash', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const before = outbound(phone).length;
    assert.equal(await postWebhook(textPayload(phone, '   \n\t ')), 200);
    await sleep(1500);
    assert.equal(outbound(phone).length, before);
    assert.ok(has(await sendInbound(phone, 'hi'), T.MAIN_MENU));
  });

  test('commands are case- and whitespace-insensitive', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, '  1  '), T.RETAIL_MENU));
    assert.ok(has(await sendInbound(phone, '  BaCk '), T.MAIN_MENU));
    assert.ok(has(await sendInbound(phone, '2'), T.CORPORATE_MENU));
    assert.ok(has(await sendInbound(phone, 'MAIN MENU'), T.MAIN_MENU));
    assert.ok(has(await sendInbound(phone, '1'), T.RETAIL_MENU));
    assert.ok(has(await sendInbound(phone, '  MENU  '), T.MAIN_MENU));
    assert.ok(has(await sendInbound(phone, '2'), T.CORPORATE_MENU));
    assert.ok(has(await sendInbound(phone, 'Go Back'), T.MAIN_MENU));
    assert.equal(await stateOf(phone), 'main_menu');
  });

  test('"back" walks up the menu tree', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    await sendInbound(phone, '6');
    assert.equal(await stateOf(phone), 'retail_size_ask');
    assert.ok(has(await sendInbound(phone, 'back'), T.RETAIL_MENU));
    assert.equal(await stateOf(phone), 'retail_menu');
    assert.ok(has(await sendInbound(phone, 'back'), T.MAIN_MENU));
    assert.equal(await stateOf(phone), 'main_menu');
    await sendInbound(phone, '2');
    await sendInbound(phone, '5');
    assert.equal(await stateOf(phone), 'corporate_account_query');
    assert.ok(has(await sendInbound(phone, 'back'), T.CORPORATE_MENU));
    assert.equal(await stateOf(phone), 'corporate_menu');
  });

  test('keyword shortcuts from the main menu', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, 'What are your trading hours?'), T.HOURS));
    assert.ok(has(await sendInbound(phone, 'Do you do LAYBY?'), T.LAYBY));
    assert.ok(has(await sendInbound(phone, 'can you embroider logos'), T.BRANDING));
    assert.ok(has(await sendInbound(phone, 'where is your shop'), T.STORE));
    assert.ok(has(await sendInbound(phone, 'Where is my order?'), T.TRACK_NONE), 'open orders listed — no reference asked');
    assert.equal(await stateOf(phone), 'main_menu');
    assert.ok(!has(await sendInbound(phone, 'how many hours will it take'), T.HOURS), '"hours" alone is not trading hours');
    assert.ok(!has(await sendInbound(phone, 'can you print my invoice'), T.BRANDING), '"print my invoice" is not branding');
  });

  test('product enquiry mentioning "tracksuits" is not misrouted to order tracking', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const r = await sendInbound(phone, 'Do you sell school tracksuits?');
    assert.ok(!has(r, T.TRACK_NONE), `bot tracked orders: ${r.join('|')}`);
    assert.notEqual(await stateOf(phone), 'order_tracking_ask');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('retail and corporate sub-menus', () => {
  test('retail options 1-6 and an out-of-range option', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const cases = [
      ['1', T.PRODUCT_LIST, 'retail_pricing'],
      ['2', T.SCHOOL_SELECT, 'retail_school_select'],
      ['3', T.HOURS, 'retail_hours'],
      ['4', T.TRACK_NONE, 'main_menu'],
      ['5', T.LAYBY, 'retail_layby'],
      ['6', T.SIZE_ASK, 'retail_size_ask'],
      ['7', T.NOT_AN_OPTION, 'retail_menu'],
    ];
    for (const [opt, text, state] of cases) {
      await sendInbound(phone, '0');
      await sendInbound(phone, '1');
      const r = await sendInbound(phone, opt);
      assert.ok(has(r, text), `retail ${opt}: ${r.join('|')}`);
      assert.equal(await stateOf(phone), state, `retail ${opt}`);
      if (opt === '1') assert.ok(has(r, '• Polo Shirt — R 150.00'), r[0]);
      if (opt === '2') assert.ok(has(r, '12. Brakpan Educational Primary'), r[0]);
    }
  });

  test('price list / hours / lay-by screens keep the shop menu numbers working (no fall-through to the main menu)', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    await sendInbound(phone, '1');
    assert.equal(await stateOf(phone), 'retail_pricing');
    assert.ok(has(await sendInbound(phone, '3'), T.HOURS));
    assert.ok(has(await sendInbound(phone, '5'), T.LAYBY));
    assert.ok(has(await sendInbound(phone, '6'), T.SIZE_ASK));
  });

  test('typing a school name shows that school; the list also accepts a typed name', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    assert.ok(has(await sendInbound(phone, 'Stoffberg'), '*Hoerskool Stoffberg*'));
    await sendInbound(phone, '2');
    const r = await sendInbound(phone, 'dalpark');
    assert.ok(has(r, '1. Dalpark Primary') && has(r, '2. Dalpark Secondary'), r.join('|'));
    assert.ok(has(await sendInbound(phone, '2'), '*Dalpark Secondary*'));
  });

  test('school selection by number shows that school (no catalog → consultant hint)', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    await sendInbound(phone, '2');
    const r = await sendInbound(phone, '3');
    assert.ok(has(r, '*Laerskool Brakpan Oos*'), r.join('|'));
    assert.equal(await stateOf(phone), 'retail_menu');
    // invalid number re-shows the list
    await sendInbound(phone, '2');
    assert.ok(has(await sendInbound(phone, '13'), T.SCHOOL_SELECT));
    assert.equal(await stateOf(phone), 'retail_school_select');
  });

  test('school #9 ("Exed Privaat Skool") can be selected — "9" is not hijacked as the consultant shortcut', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    const list = await sendInbound(phone, '2');
    assert.ok(has(list, "9. Exed Privaat Skool"));
    const r = await sendInbound(phone, '9');
    assert.ok(has(r, "Exed Privaat Skool"), `expected school info, got: ${r.join('|')}`);
    assert.notEqual(await stateOf(phone), 'awaiting_consultant');
  });

  test('corporate options 1-5, 9 and an out-of-range option', async () => {
    const phone = await orderingClient('Corp Person');
    const cases = [
      ['1', T.NO_PREVIOUS_ORDER, 'order_gathering'],
      ['2', T.QUOTE_ASK, 'quotation_ask_description'],
      ['3', T.TRACK_NONE, 'main_menu'],
      ['4', T.TRACK_NONE, 'main_menu'],
      ['5', T.ACCOUNT_ASK, 'corporate_account_query'],
      ['7', T.NOT_AN_OPTION, 'corporate_menu'],
      ['9', T.CONSULTANT, 'awaiting_consultant'],
    ];
    for (const [opt, text, state] of cases) {
      await sendInbound(phone, '0');
      await sendInbound(phone, '2');
      const r = await sendInbound(phone, opt);
      assert.ok(has(r, text), `corporate ${opt}: ${r.join('|')}`);
      assert.equal(await stateOf(phone), state, `corporate ${opt}`);
    }
  });

  test('corporate account query (option 5) creates an account_query ticket', async () => {
    const phone = await registeredClient('Account Asker');
    await sendInbound(phone, '2');
    await sendInbound(phone, '5');
    assert.ok(has(await sendInbound(phone, 'inv'), T.ACCOUNT_ASK), 'too-short query should re-prompt');
    const r = await sendInbound(phone, 'Please resend invoice INV-2201, the VAT number is wrong');
    assert.ok(has(r, T.ACCOUNT_LOGGED));
    assert.ok(has(r, 'within *4 business hours*'), 'response time stated');
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM tickets WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'account_query');
    assert.equal(rows[0].status, 'open');
    assert.ok(has(r, `#${rows[0].id.replace(/-/g, '').slice(0, 8).toUpperCase()}`), 'ticket number given');
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    assert.ok(await waitForEmail((b) => String(b.subject).includes('New Ticket — Account Query')));
  });

  test('corporate "6" (old numbering) still reaches a consultant and notifies consultants', async () => {
    const phone = await registeredClient('Silent Corp');
    await sendInbound(phone, '2');
    const r = await sendInbound(phone, '6');
    assert.ok(has(r, T.CONSULTANT));
    const mail = await waitForEmail((b) => String(b.subject).includes('wants to speak to a consultant — Silent Corp'), 4000);
    assert.ok(mail, 'expected a "Customer wants to speak to a consultant" email');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('AI size-availability FAQ (retail option 6)', () => {
  test('AI answer is relayed; escalate and malformed AI output fall back gracefully', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '1');
    await sendInbound(phone, '6');

    env.setAiResponse({ type: 'answer', text: 'Yes! The Polo Shirt is available in XL.' });
    const geminiBefore = env.fakeCalls('gemini').length;
    let r = await sendInbound(phone, 'Do you have the polo in XL?');
    assert.equal(r.length, 1);
    assert.ok(r[0].startsWith('Yes! The Polo Shirt is available in XL.'), r[0]);
    const call = env.fakeCalls('gemini')[geminiBefore];
    assert.ok(JSON.stringify(call.body).includes('Do you have the polo in XL?'), 'question must be sent to the AI');
    assert.ok(JSON.stringify(call.body).includes('Polo Shirt'), 'catalog must be sent to the AI');
    assert.equal(await stateOf(phone), 'retail_size_ask');

    env.setAiResponse({ type: 'escalate', reason: 'refund question' });
    r = await sendInbound(phone, 'Can I get a refund?');
    assert.ok(has(r, "couldn't find size information"), r.join('|'));

    env.setAiResponse('this is { not json');
    r = await sendInbound(phone, 'Do you have hoodies in 2XL?');
    assert.ok(has(r, "couldn't find size information"), r.join('|'));
    assert.equal(await stateOf(phone), 'retail_size_ask');

    // keywords are disabled in this data-collection state (question goes to AI, not hours screen)
    env.setAiResponse({ type: 'answer', text: 'We open at 8.' });
    r = await sendInbound(phone, 'what time do you open');
    assert.ok(r[0].startsWith('We open at 8.'), r[0]);
    env.setAiResponse({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('quotation flow', () => {
  test('registration asks only for the school, then resumes the quotation with a thank-you by first name', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, '3'), T.REG_ASK));
    const r = await sendInbound(phone, 'Dalpark Primary');
    assert.equal(r.length, 1, 'no separate "you\'re all set" message');
    assert.ok(r[0].startsWith('Thanks, *Test*! ✅'), r[0]);
    assert.ok(has(r, T.QUOTE_ASK));
    const c = await clientOf(phone);
    assert.equal(c.name, 'Test User');
    assert.equal(c.school_name, 'Dalpark Primary');
    assert.equal(c.profile_complete, true);
    assert.equal(await stateOf(phone), 'quotation_ask_description');
  });

  test('registration at order time — a long delivery address is kept in full', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '4');
    const address = 'Please deliver to 12 Long Street, Unit 4 Business Park, Brakpan North, Gauteng, 1540, call me before arriving at the gate';
    assert.ok(address.length > 120);
    const r = await sendInbound(phone, `Dalpark Primary\n${address}`);
    assert.ok(has(r, T.ORDER_ASK_ITEMS), `reply after the details: ${JSON.stringify(r)}; state=${await stateOf(phone)}`);
    const c = await clientOf(phone);
    assert.equal(c.profile_complete, true);
    assert.equal(c.delivery_preference, 'delivery');
    assert.ok(c.physical_address.includes('12 Long Street, Unit 4 Business Park'), c.physical_address);
  });

  test('all items catalog-matched → instant quote PDF, status sent; "accept" accepts it (no order) and emails staff', async () => {
    const phone = await registeredClient('Auto Quoter');
    await sendInbound(phone, '3');
    env.setAiResponse({
      status: 'ready',
      consolidatedRequest: '50 Polo Shirts, Navy, M×50',
      items: [{ productId: polo.id, quantity: 50, colour: 'Navy', description: '50 navy polos', sizes: [{ size: 'M', qty: 50 }] }],
      unmatchedText: [],
    });
    const mediaBefore = env.fakeCalls('whatsapp-media').length;
    const r = await sendInbound(phone, 'I need 50 navy polo shirts, all medium', { timeout: 20000, settle: 1500 });
    assert.equal(r.length, 1, r.join('|'));
    assert.match(r[0], /^\[document:BRQ-Q-\d{8}-\d{4}\.pdf\]/);
    assert.ok(r[0].includes('Total: R 8625.00'), r[0]); // 50 × 150 = 7500 + 15% VAT
    assert.ok(r[0].includes('Reply *accept* to go ahead, *changes* to request edits, or *9* to talk to us. Valid until'), r[0]);
    assert.equal(env.fakeCalls('whatsapp-media').length, mediaBefore + 1, 'PDF should be uploaded');

    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM quotations WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].auto_quoted, true);
    assert.equal(Number(rows[0].total), 8625);
    assert.equal(rows[0].line_items[0].productId, polo.id);
    assert.equal(await stateOf(phone), 'main_menu');

    const acc = await sendInbound(phone, 'Accept');
    assert.ok(has(acc, `${T.QUOTE_ACCEPTED} ${rows[0].reference}`), acc.join('|'));
    assert.ok(has(acc, 'Your consultant will confirm your order and send the deposit details shortly.'));
    const { rows: after } = await db.query('SELECT status FROM quotations WHERE id = $1', [rows[0].id]);
    assert.equal(after[0].status, 'accepted');
    assert.equal((await db.query('SELECT 1 FROM orders WHERE quotation_id = $1', [rows[0].id])).rows.length, 0, 'owner decision 1: no order created');
    assert.ok(await waitForEmail((b) => String(b.subject).includes(`Quotation Accepted — Ref ${rows[0].reference}`)));
    env.setAiResponse({});
  });

  test('"accept" with no open quotation → polite no-pending message', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, 'accept'), T.NO_PENDING_QUOTE));
  });

  test('unmatched / hallucinated items → draft quote, consultant hand-off, staff emails', async () => {
    const phone = await registeredClient('Custom Buyer');
    await sendInbound(phone, '3');
    env.setAiResponse({
      status: 'ready',
      consolidatedRequest: '20 safety boots size 8; 5 magic capes',
      items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 5, description: '5 magic capes' }],
      unmatchedText: ['20 safety boots, size 8'],
    });
    const r = await sendInbound(phone, '20 safety boots size 8 and 5 capes', { timeout: 15000 });
    assert.equal(r.length, 1, r.join('|'));
    assert.ok(r[0].includes(T.DRAFT_ACK), r[0]);
    assert.ok(r[0].includes('• 20 safety boots, size 8'), r[0]);
    assert.ok(r[0].includes('• 5 magic capes'), r[0]);
    assert.ok(!r[0].includes('Reply *9*'), 'no "Reply 9" — it does not work while waiting');
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM quotations WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.ok(r[0].includes(rows[0].reference));
    assert.ok(rows[0].sla_remind_at, 'SLA reminder time must be set');
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    assert.ok(await waitForEmail((b) => String(b.subject).includes(`New Quotation Enquiry — Ref ${rows[0].reference}`)), 'quotation email');
    assert.ok(await waitForEmail((b) => String(b.subject).includes('consultant — Custom Buyer')), 'consultant email');
    const mail = await waitForEmail((b) => String(b.subject).includes(rows[0].reference));
    assert.deepEqual(mail.to, ['consultant@test.local']);
    env.setAiResponse({});
  });

  test('malformed AI JSON → graceful fallback: whole request kept as a draft for manual pricing', async () => {
    const phone = await registeredClient('Bad AI');
    await sendInbound(phone, '3');
    env.setAiResponse('```json {oops');
    const text = '100 golf shirts with logo';
    const r = await sendInbound(phone, text, { timeout: 15000 });
    assert.ok(has(r, T.DRAFT_ACK), r.join('|'));
    assert.ok(has(r, `• ${text}`), 'original text listed as needing manual pricing');
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM quotations WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.equal(rows[0].notes, text);
    assert.equal(rows[0].line_items.length, 1);
    assert.equal(rows[0].line_items[0].priceConfirmed, false);
    assert.equal(Number(rows[0].line_items[0].unitPrice), 0);
    env.setAiResponse({});
  });

  test('empty-object AI output ({}) does not crash the flow', async () => {
    const phone = await registeredClient('Empty AI');
    await sendInbound(phone, '3');
    env.setAiResponse({});
    const r = await sendInbound(phone, 'some uniforms please');
    assert.ok(has(r, T.DRAFT_ACK), r.join('|'));
  });

  test('a first message naming the items skips "describe what you need"', async () => {
    const phone = await registeredClient('Direct Asker');
    env.setAiResponse({ status: 'need_more_info', question: 'Please send: 1) colour 2) sizes' });
    const r = await sendInbound(phone, 'Hi, I need a quote for 30 Dalview jerseys');
    assert.deepEqual(r, ['Please send: 1) colour 2) sizes']);
    const c = await convoOf(phone);
    assert.equal(c.state, 'quotation_gathering');
    assert.equal(c.context.quotationHistory[0].text, 'Hi, I need a quote for 30 Dalview jerseys');
    env.setAiResponse({});
  });

  test('AI follow-up questions (everything missing in one message) are capped at 2, then the quote is finalised', async () => {
    const phone = await registeredClient('Chatty');
    await sendInbound(phone, '3');
    env.setAiResponse({ status: 'need_more_info', question: 'Please send: 1) colour 2) sizes' });
    const msgs = ['I want shirts', 'blue', 'size M'];
    for (let i = 0; i < 2; i++) {
      const r = await sendInbound(phone, msgs[i]);
      assert.deepEqual(r, ['Please send: 1) colour 2) sizes']);
      const c = await convoOf(phone);
      assert.equal(c.state, 'quotation_gathering');
      assert.equal(c.context.quotationFollowups, i + 1);
    }
    const r = await sendInbound(phone, msgs[2], { timeout: 15000 });
    assert.ok(has(r, T.DRAFT_ACK), r.join('|'));
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT notes FROM quotations WHERE client_id = $1', [client.id]);
    assert.equal(rows[0].notes, msgs.join('\n'), 'all client turns consolidated into the request');
    const c = await convoOf(phone);
    assert.equal(c.state, 'awaiting_consultant');
    assert.equal(c.context.quotationHistory, null);
    env.setAiResponse({});
  });

  test('keywords are disabled while describing a quotation ("open", "print" are data)', async () => {
    const phone = await registeredClient('Keyword Data');
    await sendInbound(phone, '3');
    env.setAiResponse({ status: 'need_more_info', question: 'How many?' });
    const r = await sendInbound(phone, 'open-collar shirts with print, where is my order of last year irrelevant');
    assert.deepEqual(r, ['How many?']);
    env.setAiResponse({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('make-an-order flow', () => {
  test('direct catalog order → summary → confirm ("yes") → order created + staff email', async () => {
    const phone = await orderingClient('Direct Buyer');
    assert.ok(has(await sendInbound(phone, '4'), T.ORDER_ASK_ITEMS), 'no quote on file → straight to "what would you like to order?"');
    env.setAiResponse({
      status: 'ready', consolidatedRequest: '10 Polo Shirts navy M',
      items: [{ productId: polo.id, quantity: 10, colour: 'Navy', sizes: [{ size: 'M', qty: 10 }] }], unmatchedText: [],
    });
    let r = await sendInbound(phone, '10 navy polos size M');
    assert.ok(has(r, T.CONFIRM_DIRECT), r.join('|'));
    assert.ok(r[0].includes('Polo Shirt — Navy  ×10  — R 1500.00'), r[0]);
    assert.ok(r[0].includes('*Total:    R 1725.00*'), r[0]);
    assert.ok(r[0].includes('R 1035.00'), r[0]);
    assert.equal(await stateOf(phone), 'order_confirm_direct');
    // anything else re-shows the summary
    assert.ok(has(await sendInbound(phone, 'hmm'), T.CONFIRM_DIRECT));
    r = await sendInbound(phone, 'yes');
    assert.ok(has(r, T.ORDER_CREATED), r.join('|'));
    const ref = r[0].match(/BRQ-O-\d{5}/)[0];
    const { rows } = await db.query('SELECT * FROM orders WHERE reference = $1', [ref]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_id, (await clientOf(phone)).id);
    assert.equal(rows[0].stage, 'deposit_pending');
    assert.equal(Number(rows[0].deposit_amount), 1035);
    assert.equal(await stateOf(phone), 'main_menu');
    assert.ok(await waitForEmail((b) => String(b.subject).includes(`New WhatsApp Order — Ref ${ref}`)));
    env.setAiResponse({});
  });

  test('direct order cancelled with "2" creates no order', async () => {
    const phone = await orderingClient('Canceller');
    await sendInbound(phone, '4');
    env.setAiResponse({ status: 'ready', items: [{ productId: polo.id, quantity: 3 }], unmatchedText: [] });
    await sendInbound(phone, '3 polos');
    assert.ok(has(await sendInbound(phone, '2'), T.MAIN_MENU));
    const { rows } = await db.query('SELECT 1 FROM orders WHERE client_id = $1', [(await clientOf(phone)).id]);
    assert.equal(rows.length, 0);
    env.setAiResponse({});
  });

  test('direct order with non-catalog items becomes a quote request for a consultant (no dead end)', async () => {
    const phone = await orderingClient('Custom Orderer');
    await sendInbound(phone, '4');
    env.setAiResponse({ status: 'ready', items: [], unmatchedText: ['30 chef jackets'] });
    const r = await sendInbound(phone, '30 chef jackets', { timeout: 15000 });
    assert.ok(has(r, T.DRAFT_ACK) && has(r, T.ORDER_TO_QUOTE) && has(r, '• 30 chef jackets'), r.join('|'));
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    const { rows } = await db.query('SELECT status FROM quotations WHERE client_id = $1', [(await clientOf(phone)).id]);
    assert.deepEqual(rows.map((x) => x.status), ['draft']);
    env.setAiResponse({});
  });

  test('order from a quotation: the latest one is offered; typed references — own, someone else\'s, draft', async () => {
    const phone = await orderingClient('Quote Orderer');
    const other = await registeredClient('Other Quoter');
    const me = await clientOf(phone);
    const them = await clientOf(other);
    const items = JSON.stringify([{ productId: polo.id, name: 'Polo Shirt', quantity: 4, unitPrice: 150, lineTotal: 600, sizes: [{ size: 'L', qty: 4 }] }]);
    const ins = (ref, clientId, status) => db.query(
      `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat, total) VALUES ($1,$2,$3,$4,600,90,690) RETURNING id`,
      [ref, clientId, status, items]);
    const mine = (await ins('BRQ-Q-20990101-0001', me.id, 'sent')).rows[0];
    await ins('BRQ-Q-20990101-0002', them.id, 'sent');
    await ins('BRQ-Q-20990101-0003', me.id, 'draft');

    let r = await sendInbound(phone, '4');
    assert.ok(has(r, `${T.ORDER_OFFER} *BRQ-Q-20990101-0001*`) && has(r, 'Total: R 690.00'), r.join('|'));
    assert.ok(has(await sendInbound(phone, 'BRQ-Q-20990101-0002'), T.QUOTE_NOT_FOUND), "another client's quote must not be found");
    assert.ok(has(await sendInbound(phone, 'BRQ-Q-20990101-0003'), T.QUOTE_NOT_READY));
    r = await sendInbound(phone, 'brq-q-20990101-0001');
    assert.ok(has(r, `${T.CONFIRM_QUOTE}BRQ-Q-20990101-0001*`), r.join('|'));
    assert.ok(r[0].includes('R 414.00'), 'deposit = 60% of 690');
    r = await sendInbound(phone, '1');
    assert.ok(has(r, T.ORDER_CREATED), r.join('|'));
    const { rows } = await db.query('SELECT * FROM orders WHERE quotation_id = $1', [mine.id]);
    assert.equal(rows.length, 1);
    const { rows: q } = await db.query('SELECT status FROM quotations WHERE id = $1', [mine.id]);
    assert.equal(q[0].status, 'accepted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('order status lookup', () => {
  let ownerPhone, orderRef, orderId;
  before(async () => {
    ownerPhone = await registeredClient('Order Owner');
    const owner = await clientOf(ownerPhone);
    const r = await api('POST', '/api/orders', { clientId: owner.id, lineItems: [{ name: 'Golf shirt', quantity: 2, unitPrice: 100 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    orderRef = r.body.order.reference;
    orderId = r.body.order.id;
    await env.waitForJobs();   // the deposit WhatsApp is out before the lookups start
  });

  test('own order via option 5 (no reference needed), via a bare reference, lowercase, and after a stage advance', async () => {
    assert.match(orderRef, /^BRQ-O-\d{5}$/);
    let r = await sendInbound(ownerPhone, '5');
    assert.ok(has(r, `Order Status — ${orderRef}`), r.join('|'));
    assert.ok(has(r, 'Current stage: *Awaiting Deposit*'));
    assert.ok(has(r, 'Deposit due to start production (60%): *R 138.00*'), 'amount still due shown');
    assert.equal(await stateOf(ownerPhone), 'main_menu');

    r = await sendInbound(ownerPhone, orderRef.toLowerCase());
    assert.ok(has(r, `Order Status — ${orderRef}`));

    // No deposit recorded on this order: the admin overrides the deposit guard (reason logged).
    const adv = await api('POST', `/api/orders/${orderId}/advance`, { estimatedCompletion: '2026-12-01', trackingNumber: 'TRK-777', override: { reason: 'test: deposit waived' } });
    assert.equal(adv.status, 200, JSON.stringify(adv.body));
    await env.waitForJobs();
    r = await sendInbound(ownerPhone, orderRef);
    const status = r.find((t) => t.includes('Order Status'));
    assert.ok(status.includes('*In Production*'), status);
    assert.ok(status.includes('TRK-777'), status);
    assert.ok(status.includes('Estimated completion: *1 Dec 2026*'), status);
  });

  test('another client cannot look up an order that is not theirs (no data leak)', async () => {
    const stranger = newPhone();
    await sendInbound(stranger, 'hi');
    const r = await sendInbound(stranger, orderRef);
    assert.ok(!has(r, `Order Status — ${orderRef}`), `stranger received: ${r.join('|')}`);
    assert.ok(has(r, T.ORDER_NOT_FOUND));
  });

  test('dashboard-created order on a client row with the same phone number (local 0… format) is found', async () => {
    const phone = newPhone();
    const local = `0${phone.slice(2)}`;
    const { rows } = await db.query(
      `INSERT INTO clients (whatsapp_number, name, profile_complete) VALUES ($1, 'Dashboard Client', true) RETURNING id`, [local]);
    const created = await api('POST', '/api/orders', { clientId: rows[0].id, lineItems: [{ name: 'Golf shirt', quantity: 2, unitPrice: 100 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await env.waitForJobs();
    const ref = created.body.order.reference;
    await sendInbound(phone, 'hi');
    const own = await clientOf(phone);
    assert.notEqual(own.id, rows[0].id, 'WhatsApp sender is a different client row');
    const r = await sendInbound(phone, ref);
    assert.ok(has(r, `Order Status — ${ref}`), r.join('|'));
    assert.ok(has(await sendInbound(phone, 'track'), `Order Status — ${ref}`), '"track" finds it too');
  });

  test('non-existent references (new and legacy formats) → not found; "5" with no orders → no dead end', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, 'BRQ-O-99999'), T.ORDER_NOT_FOUND));
    assert.ok(has(await sendInbound(phone, 'BRQ-O-20250101-0001'), T.ORDER_NOT_FOUND));
    assert.ok(has(await sendInbound(phone, '5'), T.TRACK_NONE));
    assert.equal(await stateOf(phone), 'main_menu');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('complaints / tickets', () => {
  test('a detailed first message is logged at once — category inferred, ticket number + response time, staff email', async () => {
    const phone = await registeredClient('Unhappy Customer');
    const r = await sendInbound(phone, 'My order arrived DAMAGED — two jerseys have holes');
    assert.ok(has(r, T.TICKET_LOGGED), r.join('|'));
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM tickets WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'defective');
    assert.ok(has(r, `#${rows[0].id.replace(/-/g, '').slice(0, 8).toUpperCase()}`));
    assert.ok(has(r, 'within *4 business hours*'));
    assert.equal(await stateOf(phone), 'awaiting_consultant');
    assert.ok(await waitForEmail((b) => String(b.subject).includes('New Ticket — Defective item')));
  });

  test('"I have a complaint" → category → detail check → ticket with the chosen category', async () => {
    const phone = await registeredClient('Vague Customer');
    let r = await sendInbound(phone, 'I have a complaint');
    assert.ok(has(r, T.TICKET_CAT), r.join('|'));
    assert.ok(has(await sendInbound(phone, '7'), T.TICKET_CAT), 'invalid category re-prompts');
    assert.ok(has(await sendInbound(phone, '2'), T.TICKET_DESC));
    assert.ok(has(await sendInbound(phone, 'torn'), T.TICKET_BRIEF));
    assert.equal(await stateOf(phone), 'ticket_ask_description');
    const desc = '5 of the 20 blue polo shirts have split seams on the left sleeve';
    r = await sendInbound(phone, desc);
    assert.ok(has(r, T.TICKET_LOGGED));
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT * FROM tickets WHERE client_id = $1', [client.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].category, 'defective');
    assert.equal(rows[0].description, desc);
    assert.ok(new Date(rows[0].sla_due_at) > new Date());
  });

  test('ticket category mapping 1→wrong_item, 3→missing_item, 4→other', async () => {
    for (const [opt, cat] of [['1', 'wrong_item'], ['3', 'missing_item'], ['4', 'other']]) {
      const phone = newPhone();
      await sendInbound(phone, 'hi');
      await sendInbound(phone, 'I have a complaint');
      await sendInbound(phone, opt);
      await sendInbound(phone, `Category ${opt}: the parcel I received last Friday was not right at all`);
      const { rows } = await db.query('SELECT category FROM tickets WHERE client_id = $1', [(await clientOf(phone)).id]);
      assert.deepEqual(rows.map((x) => x.category), [cat]);
    }
  });
});
