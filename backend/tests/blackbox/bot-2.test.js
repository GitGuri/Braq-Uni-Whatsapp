/**
 * Black-box tests of the WhatsApp bot (part 2): design-proof approval, human
 * hand-over, business hours / busy mode, SLA reminder, duplicate delivery,
 * concurrency, non-text / status / malformed payloads, persistence.
 * Helpers are duplicated from bot.test.js on purpose (self-contained file, own env).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { startTestEnv, ADMIN, VERIFY_TOKEN } from '../helpers/env.js';
import { isWithinBusinessHours } from '../../src/core/businessHours.js';

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

// Distinctive substrings of the templates
const T = {
  MAIN_MENU: '3️⃣  Get a quote',
  RETAIL_MENU: 'Braq Uni Shop — school uniforms',
  CORPORATE_MENU: 'bulk order enquiry',
  QUOTE_ASK: 'Please describe what you need a quotation for',
  REG_NAME: 'What is your *full name*',
  REG_SCHOOL: 'Which *school* are the uniforms for',
  REG_ADDRESS: 'Will you be collecting from our store',
  REG_DONE: "you're all set",
  ORDER_METHOD: 'How would you like to place your order',
  ORDER_ASK_REF: 'Please share your *quotation reference number*',
  ORDER_ASK_ITEMS: 'What would you like to order',
  TRACK_ASK: 'Please share your *order reference number* (e.g. BRQ-O-00001)',
  BRANDING: 'We offer the following branding services',
  STORE: 'Braq Uni — Store Information',
  HOURS: 'Braq Uni — Trading Hours',
  LAYBY: 'We offer lay-by on selected items',
  CONSULTANT: 'A consultant will reply here',
  CONSULTANT_ACK: 'your message is with our team',
  UNKNOWN: "I didn't quite catch that",
  ORDER_NOT_FOUND: "We couldn't find an order with that reference number",
  TICKET_CAT: 'Please select the category that best fits',
  TICKET_DESC: 'Please describe what happened',
  TICKET_BRIEF: 'That description is a bit brief',
  TICKET_LOGGED: 'Your issue has been logged',
  SIZE_ASK: 'Size Availability',
  SCHOOL_SELECT: 'School Uniform Information',
  COLLECTION_ASK: 'we will check the status for you right away',
  PRODUCT_LIST: 'Braq Uni — Product Pricing',
  ACCOUNT_ASK: 'What is your account query about',
  ACCOUNT_LOGGED: 'Your account query has been logged',
  REPEAT_ASK: 'previous order you\'d like to repeat',
  MANUF_ASK: 'check the manufacturing status',
  DELIVERY_ASK: 'check the delivery schedule',
  DRAFT_ACK: 'Quotation received — Ref:',
  QUOTE_ACCEPTED: 'Quotation Accepted — Ref:',
  NO_PENDING_QUOTE: "couldn't find an open quotation to accept",
  CONFIRM_DIRECT: 'Your Order Summary',
  CONFIRM_QUOTE: '📋 *Quotation: ',
  ORDER_CREATED: 'Order Placed — Ref:',
  QUOTE_NOT_FOUND: "couldn't find a quotation with that reference on your account",
  QUOTE_NOT_READY: 'still being reviewed by our team',
  CUSTOM_NOT_ALLOWED: "aren't in our standard catalog",
};


Object.assign(T, {
  OUTSIDE_HOURS: "It's currently outside our trading hours",
  HIGH_VOLUME: 'experiencing a high volume of enquiries',
  PROOF_SENT: 'Design Proof Ready — Ref:',
  PROOF_APPROVED: 'Proof Approved — Ref:',
  PROOF_REVISION_ASK: "Please describe the changes you'd like made to the design",
  PROOF_REVISION_DONE: 'Revision Noted — Ref:',
  HANDBACK: 'Our team has finished assisting you',
  MEDIA_NOTICE: 'I can only read text messages',
});

// The server evaluates trading hours in SAST (Africa/Johannesburg) whatever the host TZ,
// including SA public holidays — the rules themselves are unit-tested in
// tests/unit/businessHours.test.js, so reuse that function here.
const withinHoursNow = (date = new Date()) => isWithinBusinessHours(date);
const setBusy = (v) => api('PATCH', '/api/settings/busy_mode', { value: v });

function payloadWith(from, message) {
  const p = textPayload(from, 'x');
  p.entry[0].changes[0].value.messages = [{ from, id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), ...message }];
  return p;
}

// Every order is created from a quotation: the dashboard path takes line items.
// The deposit WhatsApp it queues is delivered before the test goes on.
async function newOrderFor(phone) {
  const client = await clientOf(phone);
  const r = await api('POST', '/api/orders', { clientId: client.id, lineItems: [{ name: 'Golf shirt', quantity: 2, unitPrice: 100 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await env.waitForJobs();
  return r.body.order;
}

before(async () => {
  env = await startTestEnv();
  db = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false }, max: 4 });
  const r = await fetch(`${env.baseUrl}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  token = (await r.json()).token;
  assert.ok(token, 'admin login failed');
  await db.query(`INSERT INTO staff (name, email, password_hash, role) VALUES ('Connie Consultant', 'consultant@test.local', 'x', 'consultant')`);
}, { timeout: 240000 });

after(async () => { await db?.end().catch(() => {}); await env?.stop(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('design proof approval', () => {
  test('POST /api/orders/:id/proof sends the proof to the client on WhatsApp', async () => {
    const phone = await registeredClient('Proof Receiver');
    const order = await newOrderFor(phone);
    const before = outbound(phone).length;
    const r = await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.test/proof-1.png', notes: 'Logo on left chest' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await stateOf(phone), 'proof_review', 'conversation is put into proof_review');
    await sleep(2000);
    const sent = outbound(phone).slice(before).map(render);
    assert.ok(has(sent, 'https://example.test/proof-1.png'),
      `client was put into proof_review but never received the proof. Outbound: ${JSON.stringify(sent)}`);
  });

  test('client replies APPROVE while a proof is pending → proof approved, back to main menu', async () => {
    const phone = await registeredClient('Proof Approver');
    const order = await newOrderFor(phone);
    await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.test/proof-2.png', notes: 'Version 1' });
    // Any other text re-prompts with the proof
    let r = await sendInbound(phone, 'hello?');
    assert.ok(has(r, `${T.PROOF_SENT} ${order.reference}`), r.join('|'));
    assert.ok(has(r, 'https://example.test/proof-2.png') && has(r, 'Version 1'));
    r = await sendInbound(phone, '  APPROVE ');
    assert.ok(has(r, `${T.PROOF_APPROVED} ${order.reference}`), r.join('|'));
    const { rows } = await db.query('SELECT proof_status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].proof_status, 'approved');
    assert.equal(await stateOf(phone), 'main_menu');
    // approving again just shows the menu
    assert.ok(has(await sendInbound(phone, 'approve'), T.MAIN_MENU));
  });

  test('client asks for a revision → notes stored, status revision_requested', async () => {
    const phone = await registeredClient('Proof Reviser');
    const order = await newOrderFor(phone);
    await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.test/proof-3.png' });
    let r = await sendInbound(phone, 'Revise');
    assert.ok(has(r, T.PROOF_REVISION_ASK) && has(r, order.reference), r.join('|'));
    assert.equal(await stateOf(phone), 'proof_revision_describe');
    r = await sendInbound(phone, 'abc');
    assert.ok(has(r, T.PROOF_REVISION_ASK), 'too-short notes re-prompt');
    const notes = 'Please make the logo 20% bigger and use navy thread';
    r = await sendInbound(phone, notes);
    assert.ok(has(r, `${T.PROOF_REVISION_DONE} ${order.reference}`), r.join('|'));
    const { rows } = await db.query('SELECT proof_status, proof_notes FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].proof_status, 'revision_requested');
    assert.equal(rows[0].proof_notes, notes);
    assert.equal(await stateOf(phone), 'main_menu');
  });

  test('"I approve the embroidery" during proof review is hijacked by the branding keyword', async () => {
    const phone = await registeredClient('Embroidery Approver');
    const order = await newOrderFor(phone);
    await api('POST', `/api/orders/${order.id}/proof`, { proofUrl: 'https://example.test/proof-4.png' });
    const r = await sendInbound(phone, 'I approve the embroidery');
    assert.ok(has(r, `${T.PROOF_APPROVED} ${order.reference}`), `got: ${r.join('|')}`);
    const { rows } = await db.query('SELECT proof_status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].proof_status, 'approved');
  });

  test('APPROVE when nothing is pending → just the main menu, no order touched', async () => {
    const phone = await registeredClient('Nothing Pending');
    const order = await newOrderFor(phone);
    const r = await sendInbound(phone, 'APPROVE');
    assert.ok(has(r, T.MAIN_MENU), r.join('|'));
    const { rows } = await db.query('SELECT proof_status FROM orders WHERE id = $1', [order.id]);
    assert.equal(rows[0].proof_status, 'none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('human hand-over', () => {
  test('awaiting_consultant: first message acknowledged with our hours, then quiet; "9" → queue; "0" cancels', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    assert.ok(has(await sendInbound(phone, '8'), T.CONSULTANT));
    const id = wamid();
    const ack = await sendInbound(phone, 'Hello, anyone there?', { id });
    assert.equal(ack.length, 1);
    assert.ok(ack[0].includes(T.CONSULTANT_ACK) && ack[0].includes('Mon–Fri 8:00–17:00, Sat 8:00–13:00'), ack[0]);
    assert.deepEqual(await sendExpectSilence(phone, '1'), [], 'menu digits are not acted on while waiting (and no second ack)');
    const { rows } = await db.query('SELECT direction, body FROM messages WHERE meta_message_id = $1', [id]);
    assert.deepEqual(rows, [{ direction: 'inbound', body: 'Hello, anyone there?' }]);
    assert.ok(has(await sendInbound(phone, '9'), "You're in the queue"));
    const cancel = await sendInbound(phone, '0');
    assert.ok(has(cancel, 'cancelled your request to talk to a person') && has(cancel, T.MAIN_MENU), cancel.join('|'));
    assert.equal(await stateOf(phone), 'main_menu');
  });

  test('inbound client messages are stored as already read by staff (unread counters never move)', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '8');
    const id = wamid();
    await sendExpectSilence(phone, 'I need help with my order please', { id, grace: 300 });
    const { rows } = await db.query('SELECT is_read_by_staff FROM messages WHERE meta_message_id = $1', [id]);
    const convo = await convoOf(phone);
    const list = await api('GET', '/api/conversations?state=awaiting_consultant&limit=100');
    const mine = (list.body.conversations || []).find((c) => c.id === convo.id);
    assert.equal(rows[0].is_read_by_staff, false, 'a fresh inbound message must be unread for staff');
    assert.ok(mine && Number(mine.unread_count) >= 1, `unread_count in inbox list = ${mine?.unread_count}`);
  });

  test('staff takeover → bot silent, staff reply delivered, handback → bot resumes', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const convo = await convoOf(phone);
    const n0 = outbound(phone).length;
    const tk = await api('PATCH', `/api/conversations/${convo.id}/takeover`);
    assert.equal(tk.status, 200, JSON.stringify(tk.body));
    assert.equal(await stateOf(phone), 'consultant_active');
    await env.waitForJobs();
    assert.deepEqual(outbound(phone).slice(n0).map(render), ['👋 *Test* from Braq Uni is now helping you. Reply here any time.'],
      'the client is told who took over (staff "Test Admin")');
    assert.deepEqual(await sendExpectSilence(phone, 'hi are you a real person?'), []);
    assert.deepEqual(await sendExpectSilence(phone, '3'), []);

    const before = outbound(phone).length;
    const rep = await api('POST', `/api/conversations/${convo.id}/reply`, { body: 'Yes, this is Connie.' });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    await env.waitForJobs(); // staff replies go through the outbox
    assert.deepEqual(outbound(phone).slice(before).map(render), ['Yes, this is Connie.']);
    assert.equal(await stateOf(phone), 'consultant_active');

    const hb = await api('PATCH', `/api/conversations/${convo.id}/handback`);
    assert.equal(hb.status, 200);
    await env.waitForJobs();
    assert.ok(has(outbound(phone).slice(before).map(render), T.HANDBACK));
    assert.equal(await stateOf(phone), 'main_menu');
    assert.ok(has(await sendInbound(phone, 'thanks'), "You're welcome"), '"thanks" gets a short reply, not the whole menu');
    assert.ok(has(await sendInbound(phone, 'hello'), T.MAIN_MENU));
  });

  test('during a live consultant chat, keyword messages make the bot jump in and leave consultant mode', async () => {
    const phone = await registeredClient('Live Chat');
    const convo = await convoOf(phone);
    await api('PATCH', `/api/conversations/${convo.id}/takeover`);
    await env.waitForJobs(); // the "… is now helping you" message goes out first
    const r = await sendExpectSilence(phone, 'Could you send me a quote for 20 shirts?');
    assert.deepEqual(r, [], `bot interrupted the human consultant with: ${r.join('|')}`);
    assert.equal(await stateOf(phone), 'consultant_active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('business hours, busy mode and SLA reminder', () => {
  test('first contact: outside-hours notice exactly when the server clock is outside trading hours', async (t) => {
    const phone = newPhone();
    const start = new Date();
    const r = await sendInbound(phone, 'hi');
    const end = new Date();
    if (withinHoursNow(start) !== withinHoursNow(end)) return t.skip('crossed a business-hours boundary mid-test');
    if (withinHoursNow(start)) {
      assert.equal(r.length, 1, r.join('|'));
      assert.ok(r[0].includes(T.MAIN_MENU));
    } else {
      assert.equal(r.length, 2, r.join('|'));
      assert.ok(r[0].includes(T.OUTSIDE_HOURS));
      assert.ok(r[1].includes(T.MAIN_MENU));
    }
    // never repeated within the same conversation
    const r2 = await sendInbound(phone, 'hi again');
    assert.equal(r2.length, 1);
    assert.ok(!has(r2, T.OUTSIDE_HOURS));
  });

  test('busy mode: new conversations get the high-volume notice (instead of the hours notice), once', async () => {
    try {
      assert.equal((await setBusy(true)).status, 200);
      const phone = newPhone();
      const r = await sendInbound(phone, 'hi');
      assert.equal(r.length, 2, r.join('|'));
      assert.ok(r[0].includes(T.HIGH_VOLUME));
      assert.ok(!has(r, T.OUTSIDE_HOURS));
      assert.ok(r[1].includes(T.MAIN_MENU));
      assert.ok(!has(await sendInbound(phone, 'hello'), T.HIGH_VOLUME));

      // a closed conversation → next message opens a new one and is greeted again
      const old = await convoOf(phone);
      assert.equal((await api('PATCH', `/api/conversations/${old.id}/close`)).status, 200);
      const r3 = await sendInbound(phone, 'me again');
      assert.ok(r3[0].includes(T.HIGH_VOLUME), r3.join('|'));
      const fresh = await convoOf(phone);
      assert.notEqual(fresh.id, old.id);
      assert.equal(fresh.state, 'main_menu');
    } finally {
      await setBusy(false);
    }
  });

  test('overdue draft quotation triggers a one-off "consultant is finalising" reminder', async () => {
    const phone = await registeredClient('Waiting Willem');
    const client = await clientOf(phone);
    await db.query(
      `INSERT INTO quotations (reference, client_id, status, sla_remind_at) VALUES ('BRQ-Q-20990202-0001', $1, 'draft', NOW() - INTERVAL '1 hour')`,
      [client.id]);
    const r = await sendInbound(phone, 'hi', { settle: 1200 });
    assert.ok(has(r, '(Ref: BRQ-Q-20990202-0001)'), r.join('|'));
    assert.ok(has(r, 'Hi *Waiting*'));
    assert.ok(has(r, T.MAIN_MENU));
    const { rows } = await db.query(`SELECT reminder_sent_at FROM quotations WHERE reference = 'BRQ-Q-20990202-0001'`);
    assert.ok(rows[0].reminder_sent_at);
    const r2 = await sendInbound(phone, 'hi', { settle: 1200 });
    assert.ok(!has(r2, 'BRQ-Q-20990202-0001'), 'reminder must only be sent once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Meta retries / duplicate delivery', () => {
  test('same wamid delivered twice (sequential retry) → processed once, one reply', async () => {
    const phone = newPhone();
    const id = wamid();
    const r1 = await sendInbound(phone, 'hi', { id });
    assert.ok(has(r1, T.MAIN_MENU));
    const n = outbound(phone).length;
    assert.equal(await postWebhook(textPayload(phone, 'hi', id)), 200);
    await sleep(2500);
    assert.equal(outbound(phone).length, n, 'retry must not produce a second reply');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM messages WHERE meta_message_id = $1', [id]);
    assert.equal(rows[0].n, 1);
  });

  test('retried state-changing message is not applied twice', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const id = wamid();
    assert.ok(has(await sendInbound(phone, '1', { id }), T.RETAIL_MENU));
    const n = outbound(phone).length;
    await postWebhook(textPayload(phone, '1', id)); // would be "product pricing" if re-processed
    await sleep(2500);
    assert.equal(outbound(phone).length, n);
    assert.equal(await stateOf(phone), 'retail_menu');
  });

  test('same wamid delivered twice concurrently (existing client) → exactly one reply', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const n = outbound(phone).length;
    const p = textPayload(phone, '2');
    await Promise.all([postWebhook(p), postWebhook(p)]);
    await waitForReplies(phone, n);
    await sleep(1500);
    assert.equal(outbound(phone).length - n, 1);
    assert.equal(await stateOf(phone), 'corporate_menu');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('concurrency (rapid messages from one user)', () => {
  test('brand-new contact sending two messages at once — both stored and answered', async () => {
    const phone = newPhone();
    await Promise.all([postWebhook(textPayload(phone, 'Hi')), postWebhook(textPayload(phone, 'I need school uniforms'))]);
    try { await waitForReplies(phone, 0, { settle: 2000 }); } catch { /* asserted below */ }
    const { rows: clients } = await db.query('SELECT id FROM clients WHERE whatsapp_number = $1', [phone]);
    assert.equal(clients.length, 1);
    const { rows: msgs } = await db.query(`SELECT body FROM messages WHERE client_id = $1 AND direction = 'inbound'`, [clients[0].id]);
    const { rows: convos } = await db.query('SELECT id FROM conversations WHERE client_id = $1 AND is_open', [clients[0].id]);
    assert.equal(convos.length, 1, 'exactly one open conversation');
    assert.equal(msgs.length, 2, `both inbound messages must be stored, got ${JSON.stringify(msgs)}`);
    assert.ok(outbound(phone).filter((c) => render(c).includes(T.MAIN_MENU)).length >= 2, 'both messages must be answered');
  });

  test('returning client (conversation closed) sending two messages at once gets exactly one open conversation', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const old = await convoOf(phone);
    await api('PATCH', `/api/conversations/${old.id}/close`);
    const n = outbound(phone).length;
    await Promise.all([postWebhook(textPayload(phone, 'hello')), postWebhook(textPayload(phone, 'hello again'))]);
    await waitForReplies(phone, n, { settle: 1500 });
    const client = await clientOf(phone);
    const { rows } = await db.query('SELECT id FROM conversations WHERE client_id = $1 AND is_open', [client.id]);
    assert.equal(rows.length, 1, `open conversations: ${rows.length}`);
  });

  test('existing client: two rapid menu choices both answered, state stays valid', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const n = outbound(phone).length;
    await Promise.all([postWebhook(textPayload(phone, '1')), postWebhook(textPayload(phone, '2'))]);
    await waitForReplies(phone, n, { settle: 1500 });
    assert.equal(outbound(phone).length - n, 2);
    const c = await convoOf(phone);
    // One sender's messages are processed one at a time, in arrival order (the
    // arrival order of two simultaneous POSTs is undefined): "1" then "2" ends in
    // the school list, "2" then "1" in the corporate repeat-order question.
    // "2" then "1" = bulk orders → repeat previous order, which first asks for the missing details.
    assert.ok(['retail_school_select', 'registration_name'].includes(c.state), c.state);
    assert.equal(typeof c.context, 'object');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM conversations WHERE client_id = $1 AND is_open', [c.client_id]);
    assert.equal(rows[0].n, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('non-text, status-only and malformed payloads', () => {
  test('image/audio/document/sticker/location/interactive/reaction messages: 200, placeholders stored, one short notice, no crash', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const n = outbound(phone).length;
    const kinds = [
      { type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 'x', caption: 'defect photo' } },
      { type: 'audio', audio: { id: 'MEDIA2', mime_type: 'audio/ogg; codecs=opus', voice: true } },
      { type: 'document', document: { id: 'MEDIA3', filename: 'PO-123.pdf', mime_type: 'application/pdf' } },
      { type: 'sticker', sticker: { id: 'MEDIA4', mime_type: 'image/webp' } },
      { type: 'location', location: { latitude: -26.2, longitude: 28.3 } },
      { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '1', title: 'Shop' } } },
      { type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } },
      { type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] },
    ];
    for (const k of kinds) {
      const p = payloadWith(phone, k);
      assert.equal(await postWebhook(p), 200, k.type);
      // let each one be processed before the next (as real users send them seconds apart)
      const id = p.entry[0].changes[0].value.messages[0].id;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const { rows } = await db.query('SELECT 1 FROM messages WHERE meta_message_id = $1', [id]);
        if (rows.length) break;
        await sleep(100);
      }
      await sleep(200);
    }
    await sleep(1000);
    const replies = outbound(phone).slice(n).map(render);
    assert.equal(replies.length, 1, `exactly one "text only" notice for the burst: ${JSON.stringify(replies)}`);
    assert.ok(replies[0].includes(T.MEDIA_NOTICE), replies[0]);

    const client = await clientOf(phone);
    const { rows } = await db.query(
      `SELECT body, is_read_by_staff FROM messages WHERE client_id = $1 AND direction = 'inbound' AND body LIKE '[%' ORDER BY created_at`, [client.id]);
    assert.deepEqual(rows.map((r) => r.body), [
      '[image received] defect photo',
      '[voice note received]',
      '[document received: PO-123.pdf]',
      '[sticker received]',
      '[location shared: -26.2, 28.3]',
    ], 'interactive / reaction / unsupported are ignored');
    assert.ok(rows.every((r) => r.is_read_by_staff === false), 'attachments must show as unread for staff');
    assert.equal(await stateOf(phone), 'main_menu', 'attachments do not change the bot state');
    assert.ok(has(await sendInbound(phone, 'hi'), T.MAIN_MENU), 'server still processes text afterwards');
  });

  test('attachment during a consultant chat → stored, bot silent', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    await sendInbound(phone, '8');
    const n = outbound(phone).length;
    const p = payloadWith(phone, { type: 'image', image: { id: 'MEDIA9', mime_type: 'image/jpeg' } });
    assert.equal(await postWebhook(p), 200);
    await sleep(2000);
    assert.equal(outbound(phone).length, n);
    const { rows } = await db.query('SELECT body FROM messages WHERE meta_message_id = $1', [p.entry[0].changes[0].value.messages[0].id]);
    assert.deepEqual(rows, [{ body: '[image received]' }]);
    assert.equal(await stateOf(phone), 'awaiting_consultant');
  });

  test('status-only, foreign-object, empty and malformed payloads: 200, nothing sent, server healthy', async () => {
    const phone = newPhone();
    const statusOnly = textPayload(phone, 'x');
    delete statusOnly.entry[0].changes[0].value.messages;
    statusOnly.entry[0].changes[0].value.statuses = [
      { id: 'wamid.OUT1', status: 'delivered', timestamp: '1700000000', recipient_id: phone },
      { id: 'wamid.OUT2', status: 'failed', recipient_id: phone, errors: [{ code: 131047 }] },
    ];
    const bodies = [
      statusOnly,
      { ...textPayload(phone, 'hi'), object: 'page' },
      { object: 'whatsapp_business_account' },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'account_update', value: {} }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: null }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
      payloadWith(phone, { type: 'text' }),
      payloadWith(phone, { type: 'text', text: { body: 12345 } }),
      {},
    ];
    for (const b of bodies) assert.equal(await postWebhook(b), 200, JSON.stringify(b).slice(0, 80));
    await sleep(1500);
    assert.equal(outbound(phone).length, 0);
    assert.equal((await fetch(`${env.baseUrl}/health`)).status, 200);
    assert.ok(has(await sendInbound(phone, 'hi'), T.MAIN_MENU));
  });

  test('webhook POST signature: unsigned / wrong signature → 401 and not processed; valid → 200 processed', async () => {
    const phone = newPhone();
    const raw = JSON.stringify(textPayload(phone, 'hi'));
    const post = (headers) => fetch(`${env.baseUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });

    let r = await post({});
    assert.equal(r.status, 401, 'unsigned');
    r = await post({ 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
    assert.equal(r.status, 401, 'wrong signature');
    r = await post({ 'X-Hub-Signature-256': signBody(raw + ' ') });
    assert.equal(r.status, 401, 'signature of different bytes');
    r = await post({ 'X-Hub-Signature-256': signBody(raw).replace('sha256=', '') });
    assert.equal(r.status, 401, 'missing sha256= prefix');
    r = await post({ 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', 'not-the-secret').update(raw).digest('hex')}` });
    assert.equal(r.status, 401, 'signed with another secret');
    await sleep(1500);
    assert.equal(outbound(phone).length, 0, 'rejected payloads must not be processed');
    assert.equal(await clientOf(phone), undefined, 'no client created from a rejected payload');

    r = await post({ 'X-Hub-Signature-256': signBody(raw) });
    assert.equal(r.status, 200);
    assert.ok(has(await waitForReplies(phone, 0), T.MAIN_MENU), 'validly signed message is processed');
  });

  test('webhook verification handshake (GET)', async () => {
    const ok = await fetch(`${env.baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '12345');
    const bad = await fetch(`${env.baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    assert.equal(bad.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('persistence of inbound/outbound messages', () => {
  test('inbound and outbound messages are stored on the conversation with their Meta ids', async () => {
    const phone = newPhone();
    const id = wamid();
    const t0 = Date.now();
    const r = await sendInbound(phone, 'Good morning', { id });
    const convo = await convoOf(phone);
    const { rows } = await db.query(
      'SELECT direction, body, meta_message_id FROM messages WHERE conversation_id = $1 ORDER BY created_at, direction', [convo.id]);
    assert.equal(rows[0].direction, 'inbound');
    assert.equal(rows[0].body, 'Good morning');
    assert.equal(rows[0].meta_message_id, id);
    const out = rows.filter((m) => m.direction === 'outbound');
    assert.deepEqual(out.map((m) => m.body), r, 'every bot reply is persisted verbatim');
    for (const m of out) assert.match(m.meta_message_id, /^wamid\.FAKE_/);
    assert.ok(new Date(convo.last_message_at).getTime() >= t0 - 5000);

    const got = await api('GET', `/api/conversations/${convo.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.messages.length, rows.length);
  });

  test('staff replies are persisted as outbound with the Meta id', async () => {
    const phone = newPhone();
    await sendInbound(phone, 'hi');
    const convo = await convoOf(phone);
    const rep = await api('POST', `/api/conversations/${convo.id}/reply`, { body: '  Hello from staff  ' });
    assert.equal(rep.status, 200);
    await env.waitForJobs(); // queued through the outbox; the Meta id is filled in once sent
    const { rows } = await db.query(
      `SELECT id, direction, meta_message_id FROM messages WHERE conversation_id = $1 AND body = 'Hello from staff'`, [convo.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].direction, 'outbound');
    assert.equal(rows[0].id, rep.body.messageId);
    assert.match(rows[0].meta_message_id, /^wamid\.FAKE_/);
  });
});
