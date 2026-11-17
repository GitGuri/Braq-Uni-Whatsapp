/**
 * Black-box: the durable WhatsApp webhook. POST /webhook stores each inbound
 * message in inbound_events and queues 'inbound.process' (FIFO per sender) in
 * one transaction, answering 200 only after the commit (500 when it cannot be
 * stored, so Meta retries). The bot's replies go through the outbox and are
 * recorded in messages; delivery receipts update messages.status.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startBlackbox, newPhone, sleep } from '../helpers/blackbox.js';

let bb;
before(async () => { bb = await startBlackbox(); });
after(async () => { await bb?.stop(); });

const signBody = (raw) => `sha256=${crypto.createHmac('sha256', 'fake').update(raw).digest('hex')}`;
const wamid = () => `wamid.WH_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const value = (v) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...v } }] }] });
const textPayload = (from, body, id = wamid()) => value({ messages: [{ from, id, timestamp: '1', type: 'text', text: { body } }] });

async function post(payload) {
  const raw = JSON.stringify(payload);
  const r = await fetch(`${bb.env.baseUrl}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signBody(raw) }, body: raw,
  });
  await r.text();
  return r.status;
}

const inboundBodies = async (phone) => (await bb.db.query(
  `SELECT m.body FROM messages m JOIN clients c ON c.id = m.client_id
   WHERE c.whatsapp_number = $1 AND m.direction = 'inbound' ORDER BY m.created_at, m.id`, [phone])).rows.map((r) => r.body);

test('a duplicate delivery (same wamid) is stored and answered once', async () => {
  const phone = await bb.registeredPhone();
  const before = bb.textsTo(phone).length;
  const payload = textPayload(phone, '1');
  assert.equal(await post(payload), 200);
  assert.equal(await post(payload), 200);
  await bb.env.waitForJobs();
  await sleep(300);
  await bb.env.waitForJobs();

  const id = payload.entry[0].changes[0].value.messages[0].id;
  const { rows: events } = await bb.db.query('SELECT processed_at FROM inbound_events WHERE meta_message_id = $1', [id]);
  assert.equal(events.length, 1);
  assert.ok(events[0].processed_at);
  const { rows: jobs } = await bb.db.query(`SELECT 1 FROM jobs WHERE type = 'inbound.process' AND payload->>'eventId' = (SELECT id::text FROM inbound_events WHERE meta_message_id = $1)`, [id]);
  assert.equal(jobs.length, 1, 'processing queued once');
  assert.equal((await bb.db.query('SELECT 1 FROM messages WHERE meta_message_id = $1', [id])).rows.length, 1);
  const replies = bb.textsTo(phone).slice(before);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Uni Shop/);
});

test('5 rapid messages from one client are processed — and answered — in order', async () => {
  const phone = await bb.registeredPhone();
  const before = bb.textsTo(phone).length;
  const sent = ['1', 'back', '2', 'back', '5'];
  for (const text of sent) assert.equal(await post(textPayload(phone, text)), 200);
  await bb.env.waitForJobs({ all: true });
  await sleep(300);
  await bb.env.waitForJobs({ all: true });

  assert.deepEqual(await inboundBodies(phone).then((b) => b.slice(-5)), sent);
  const replies = bb.textsTo(phone).slice(before);
  assert.equal(replies.length, 5, replies.join('\n---\n'));
  const expected = [/Uni Shop/, /Get a quote/, /bulk order enquiry/, /Get a quote/, /don't have any open orders/];
  replies.forEach((r, i) => assert.match(r, expected[i], `reply ${i + 1} out of order`));
  assert.equal((await bb.convoOf(phone)).state, 'main_menu', 'no open orders → nothing to pick from');
});

test('the bot reply is recorded in messages (outbox: job id, WhatsApp id, status)', async () => {
  const phone = newPhone();
  await bb.sendInbound(phone, 'hi');
  await bb.env.waitForJobs();
  const convo = await bb.convoOf(phone);
  const { rows } = await bb.db.query(
    `SELECT direction, body, status, job_id, meta_message_id FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [convo.id]);
  assert.equal(rows[0].direction, 'inbound');
  const out = rows.filter((m) => m.direction === 'outbound');
  assert.equal(out.length, bb.textsTo(phone).length, 'one row per message sent');
  for (const m of out) {
    assert.equal(m.status, 'sent');
    assert.ok(m.job_id);
    assert.match(m.meta_message_id, /^wamid\.FAKE_/);
  }
  assert.ok(out.some((m) => /Get a quote/.test(m.body)));
});

test('delivery receipts update messages.status (never backwards)', async () => {
  const phone = newPhone();
  await bb.sendInbound(phone, 'hi');
  await bb.env.waitForJobs();
  const convo = await bb.convoOf(phone);
  const { rows } = await bb.db.query(
    `SELECT meta_message_id FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`, [convo.id]);
  const id = rows[0].meta_message_id;
  const receipt = (status) => post(value({ statuses: [{ id, status, timestamp: '1', recipient_id: phone }] }));
  assert.equal(await receipt('read'), 200);
  assert.equal(await receipt('delivered'), 200);
  await bb.env.waitForJobs();
  assert.equal((await bb.db.query('SELECT status FROM messages WHERE meta_message_id = $1', [id])).rows[0].status, 'read');
});

test('when the event cannot be stored the webhook answers 500 (Meta retries) — the retry is processed once', async () => {
  const phone = await bb.registeredPhone();
  const before = bb.textsTo(phone).length;
  const payload = textPayload(phone, '2');
  await bb.db.query(`CREATE OR REPLACE FUNCTION test_fail_inbound() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'simulated database failure'; END $$ LANGUAGE plpgsql`);
  await bb.db.query('CREATE TRIGGER test_fail_inbound BEFORE INSERT ON inbound_events FOR EACH ROW EXECUTE FUNCTION test_fail_inbound()');
  try {
    assert.equal(await post(payload), 500);
  } finally {
    await bb.db.query('DROP TRIGGER IF EXISTS test_fail_inbound ON inbound_events');
    await bb.db.query('DROP FUNCTION IF EXISTS test_fail_inbound()');
  }
  const id = payload.entry[0].changes[0].value.messages[0].id;
  assert.equal((await bb.db.query('SELECT 1 FROM inbound_events WHERE meta_message_id = $1', [id])).rows.length, 0, 'nothing half-stored');
  await bb.env.waitForJobs();
  assert.equal(bb.textsTo(phone).length, before, 'no reply for the failed delivery');

  assert.equal(await post(payload), 200, "Meta's retry");
  await bb.env.waitForJobs();
  await sleep(300);
  await bb.env.waitForJobs();
  const replies = bb.textsTo(phone).slice(before);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /bulk order enquiry/);
});

test('unsigned posts are rejected; non-message payloads are acknowledged and ignored', async () => {
  const raw = JSON.stringify(textPayload(newPhone(), 'hi'));
  const r = await fetch(`${bb.env.baseUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
  assert.equal(r.status, 401);
  assert.equal(await post({ object: 'page', entry: [] }), 200);
});
