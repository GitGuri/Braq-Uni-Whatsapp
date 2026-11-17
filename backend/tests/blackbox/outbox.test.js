/**
 * Black-box: the WhatsApp outbox. Client messages are queued ('whatsapp.send')
 * in the same transaction as the change that causes them, recorded in the
 * conversation at once, retried with backoff while WhatsApp fails, and
 * dead-lettered (message marked failed) after max_attempts. Fakes: the next N
 * Graph sends answer HTTP 500 (FAKE_WA_FAIL); backoff base 20 ms.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startBlackbox, sleep } from '../helpers/blackbox.js';

let bb;
before(async () => { bb = await startBlackbox({ env: { JOB_BACKOFF_BASE_MS: '20' } }); });
afterEach(() => bb?.env.setWaFailures(0));
after(async () => { await bb?.stop(); });

async function chat() {
  const client = await bb.makeClient();
  const { rows } = await bb.db.query(
    `INSERT INTO conversations (client_id, state) VALUES ($1, 'awaiting_consultant') RETURNING *`, [client.id]);
  return { client, convo: rows[0] };
}
const reply = (convoId, body) => bb.ok(bb.api('POST', `/api/conversations/${convoId}/reply`, { token: bb.consultant.token, body: { body } }));
const job = async (id) => (await bb.db.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const sendsTo = (phone, service = 'whatsapp') => bb.env.fakeCalls(service).filter((c) => c.body?.to === phone);

test('WhatsApp down twice → retried with backoff, then delivered once with exactly one messages row', async () => {
  const { client, convo } = await chat();
  bb.env.setWaFailures(2);
  const r = await reply(convo.id, 'Your order is on its way');
  assert.equal(r.queued, true);

  // Recorded in the conversation straight away, before any send succeeded.
  const queued = (await bb.db.query('SELECT status FROM messages WHERE id = $1', [r.messageId])).rows[0];
  assert.ok(['queued', 'sent'].includes(queued.status));

  await bb.env.waitForJobs({ all: true });
  const j = await job(r.jobId);
  assert.deepEqual([j.status, j.attempts], ['done', 3]);
  assert.equal(sendsTo(client.whatsapp_number, 'whatsapp-failed').length, 2);
  assert.equal(sendsTo(client.whatsapp_number).length, 1, 'delivered once');

  const { rows } = await bb.db.query(
    `SELECT id, status, meta_message_id FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [convo.id]);
  assert.equal(rows.length, 1, 'exactly one messages row');
  assert.deepEqual([rows[0].id, rows[0].status], [r.messageId, 'sent']);
  assert.match(rows[0].meta_message_id, /^wamid\.FAKE_/);
});

test('WhatsApp down for good → dead after max_attempts; the message shows as failed', async () => {
  const { client, convo } = await chat();
  bb.env.setWaFailures(1000);
  const r = await reply(convo.id, 'This one will not arrive');
  await bb.env.waitForJobs({ all: true, timeoutMs: 30000 });
  const j = await job(r.jobId);
  assert.equal(j.status, 'dead');
  assert.equal(j.attempts, j.max_attempts);
  assert.match(j.last_error, /WhatsApp send failed/);
  assert.equal(sendsTo(client.whatsapp_number).length, 0);
  assert.equal(sendsTo(client.whatsapp_number, 'whatsapp-failed').length, j.max_attempts);
  const { rows } = await bb.db.query(`SELECT status FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [convo.id]);
  assert.deepEqual(rows.map((m) => m.status), ['failed']);
});

test('bot replies survive an outage too: the client still gets them, in order', async () => {
  const phone = await bb.registeredPhone();
  const before = bb.textsTo(phone).length;
  bb.env.setWaFailures(2);
  const raw = await bb.sendInbound(phone, '1', { timeout: 15000 });
  assert.ok(raw.length >= 1);
  await bb.env.waitForJobs({ all: true });
  const replies = bb.textsTo(phone).slice(before);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Uni Shop/);
});

test('dedupe: re-running a broadcast fan-out sends nothing twice', async () => {
  const client = await bb.makeClient({ type: 'reseller' });
  await bb.order(client);
  await bb.env.waitForJobs({ all: true });
  const baseline = sendsTo(client.whatsapp_number).length; // e.g. the deposit request
  const b = await bb.ok(bb.api('POST', '/api/broadcasts/busy', { token: bb.admin.token }), 202);
  await bb.env.waitForJobs({ all: true });
  const first = sendsTo(client.whatsapp_number).length;
  assert.equal(first, baseline + 1);

  const { rows } = await bb.db.query(`SELECT payload FROM jobs WHERE type = 'broadcast.fanout' AND payload->>'broadcastId' = $1`, [b.broadcastId]);
  await bb.db.query(`INSERT INTO jobs (type, payload) VALUES ('broadcast.fanout', $1)`, [rows[0].payload]);
  await bb.env.waitForJobs({ all: true });
  await sleep(200);
  assert.equal(sendsTo(client.whatsapp_number).length, first);
  const { rows: sendJobs } = await bb.db.query(
    `SELECT dedupe_key FROM jobs WHERE type = 'whatsapp.send' AND payload->>'broadcastId' = $1`, [b.broadcastId]);
  assert.ok(sendJobs.length >= 1);
  assert.equal(new Set(sendJobs.map((j) => j.dedupe_key)).size, sendJobs.length);
  assert.ok(sendJobs.every((j) => j.dedupe_key.startsWith(`broadcast:${b.broadcastId}:`)));
});
