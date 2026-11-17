/**
 * Black-box: broadcasts are queued, not sent inside the request.
 * POST /api/broadcasts/{delay,busy,custom} → 202 { broadcastId, recipients,
 * status, total, sent, failed } with a broadcasts row ('queued'); the worker
 * fans out one WhatsApp send per recipient and fills in sent_count /
 * failed_count / status 'done'. Sending needs broadcast.send (admin, manager);
 * the history stays readable by every staff member.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBlackbox } from '../helpers/blackbox.js';

let bb;
before(async () => { bb = await startBlackbox({ env: { JOB_BACKOFF_BASE_MS: '20' } }); });
after(async () => { await bb?.stop(); });

const row = async (id) => (await bb.db.query('SELECT * FROM broadcasts WHERE id = $1', [id])).rows[0];
const sentTo = (phones) => bb.env.fakeCalls('whatsapp').filter((c) => phones.includes(c.body?.to));

test('custom broadcast: 202, fanned out to every recipient, counts and status recorded', async () => {
  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(await bb.makeClient({ type: 'hospitality' }));
  const phones = clients.map((c) => c.whatsapp_number);
  const { rows: [{ n }] } = await bb.db.query(`SELECT COUNT(DISTINCT whatsapp_number)::int AS n FROM clients WHERE client_type = 'hospitality'`);

  const r = await bb.api('POST', '/api/broadcasts/custom', { token: bb.manager.token, body: { message: 'Season special', audience: '__all__' } });
  assert.equal(r.status, 202, r.text);
  assert.ok(r.json.broadcastId);
  assert.ok(r.json.recipients >= n);
  assert.equal(r.json.status, 'queued');
  assert.equal(r.json.sent, r.json.recipients, 'legacy field: recipients queued');
  assert.equal(r.json.total, r.json.recipients);
  assert.equal((await row(r.json.broadcastId)).recipient_count, r.json.recipients);

  await bb.env.waitForJobs({ all: true });
  const calls = sentTo(phones);
  assert.equal(calls.length, phones.length, 'one message per recipient');
  assert.ok(calls.every((c) => c.body.text.body === 'Season special'));
  const b = await row(r.json.broadcastId);
  assert.deepEqual([b.status, b.sent_count, b.failed_count], ['done', r.json.recipients, 0]);
});

test('a recipient whose sends keep failing is counted as failed; the others are delivered', async () => {
  const ok1 = await bb.makeClient({ type: 'church' });
  const ok2 = await bb.makeClient({ type: 'church' });
  const r = await bb.ok(bb.api('POST', '/api/broadcasts/custom', { token: bb.admin.token, body: { message: 'Hi church', audience: 'all_clients' } }), 202);
  await bb.env.waitForJobs({ all: true });
  const b = await row(r.broadcastId);
  assert.equal(b.status, 'done');
  assert.equal(b.sent_count + b.failed_count, r.recipients);
  assert.equal(sentTo([ok1.whatsapp_number, ok2.whatsapp_number]).filter((c) => c.body.text?.body === 'Hi church').length, 2);

  await bb.makeClient({ type: 'corporate' });
  bb.env.setWaFailures(1000);
  try {
    const dead = await bb.ok(bb.api('POST', '/api/broadcasts/custom', { token: bb.admin.token, body: { message: 'Never', audience: 'corporate' } }), 202);
    assert.ok(dead.recipients >= 1);
    await bb.env.waitForJobs({ all: true, timeoutMs: 30000 });
    const d = await row(dead.broadcastId);
    assert.deepEqual([d.status, d.sent_count, d.failed_count], ['done', 0, dead.recipients]);
  } finally {
    bb.env.setWaFailures(0);
  }
});

test('image / PDF broadcasts send the media with the caption', async () => {
  const c = await bb.makeClient({ type: 'security' });
  const r = await bb.ok(bb.api('POST', '/api/broadcasts/custom', {
    token: bb.admin.token, body: { message: 'Catalogue', audience: 'all_clients', mediaId: 'MEDIA_1', mediaType: 'pdf', mediaFilename: 'cat.pdf' },
  }), 202);
  await bb.env.waitForJobs({ all: true });
  const [call] = sentTo([c.whatsapp_number]);
  assert.equal(call.body.type, 'document');
  assert.deepEqual([call.body.document.id, call.body.document.filename, call.body.document.caption], ['MEDIA_1', 'cat.pdf', 'Catalogue']);
  assert.equal((await row(r.broadcastId)).body, 'Catalogue\n[image:MEDIA_1]');
});

test('busy / delay notices: 202 and fan-out to clients with open orders', async () => {
  const client = await bb.makeClient({ type: 'government' });
  const order = await bb.order(client);
  await bb.env.waitForJobs({ all: true });
  bb.env.clearFakeCalls();
  const d = await bb.ok(bb.api('POST', '/api/broadcasts/delay', { token: bb.admin.token }), 202);
  assert.ok(d.recipients >= 1);
  await bb.env.waitForJobs({ all: true });
  const [delay] = sentTo([client.whatsapp_number]);
  assert.match(delay.body.text.body, new RegExp(order.reference));

  const b = await bb.ok(bb.api('POST', '/api/broadcasts/busy', { token: bb.admin.token }), 202);
  await bb.env.waitForJobs({ all: true });
  assert.equal(sentTo([client.whatsapp_number]).length, 2);
  assert.equal((await row(b.broadcastId)).status, 'done');
});

test('consultants cannot send (403, nothing queued) but can read the history', async () => {
  const { rows: [{ n: before }] } = await bb.db.query('SELECT COUNT(*)::int AS n FROM broadcasts');
  for (const path of ['/api/broadcasts/delay', '/api/broadcasts/busy', '/api/broadcasts/custom']) {
    const r = await bb.api('POST', path, { token: bb.consultant.token, body: { message: 'nope' } });
    assert.equal(r.status, 403, path);
  }
  const { rows: [{ n: afterCount }] } = await bb.db.query('SELECT COUNT(*)::int AS n FROM broadcasts');
  assert.equal(afterCount, before);
  const h = await bb.api('GET', '/api/broadcasts', { token: bb.consultant.token });
  assert.equal(h.status, 200);
  assert.ok(h.json.broadcasts.length >= 1);
  assert.ok(h.json.broadcasts.every((x) => 'status' in x && 'sent_count' in x));
});
