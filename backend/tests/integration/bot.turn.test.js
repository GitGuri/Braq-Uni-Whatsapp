// The bot after the split (modules/bot/{router,reply,state,gathering}.js +
// states/*) against a real Postgres: one turn = one transaction (state, inbound
// message, queued replies, staff emails, processed_at), the outbox, the shared
// AI gathering loop, proof-feedback emails, the durable webhook → inbound.process
// path and delivery receipts (message.status).
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, withFailingTrigger } from '../helpers/db.js';

const t = await setupTestDb();
const bot = await t.load('modules/bot/router.js');
const webhook = await t.load('modules/webhook/controller.js');

const PHONE = '27820000777';
let seq = 0;
const say = (body, id = `turn.${++seq}`) => bot.handleInbound({ phoneNumber: PHONE, metaMessageId: id, body });
const replies = () => t.wa.texts(PHONE);

async function existing(state = 'main_menu', context = {}, clientFields = {}) {
  const client = await t.factory.client({ whatsapp_number: PHONE, name: 'Thandi Turn', client_type: 'corporate', profile_complete: true, ...clientFields });
  const convo = await t.factory.conversation({ client_id: client.id, state, context });
  return { client, convo };
}
const convoRow = (id) => t.one('SELECT * FROM conversations WHERE id = $1', [id]);
const messages = (convoId) => t.query(
  'SELECT direction, body, status, job_id FROM messages WHERE conversation_id = $1 ORDER BY created_at, id', [convoId]).then((r) => r.rows);

beforeEach(() => t.reset());
after(() => t.stop());

describe('one turn = one transaction (outbox)', () => {
  test('replies are recorded in the conversation at once (queued) and sent by the worker', async () => {
    const { convo } = await existing();
    await say('1');
    assert.deepEqual(replies(), [], 'nothing sent before the worker runs');
    let rows = await messages(convo.id);
    assert.deepEqual(rows.map((m) => [m.direction, m.status]), [['inbound', null], ['outbound', 'queued']]);
    assert.match(rows[1].body, /Uni Shop/);
    assert.equal((await convoRow(convo.id)).state, 'retail_menu');

    await t.drainJobs();
    assert.equal(replies().length, 1);
    rows = await messages(convo.id);
    assert.equal(rows[1].status, 'sent');
    assert.equal(rows.filter((m) => m.direction === 'outbound').length, 1, 'exactly one outbound row per reply');
  });

  test('a turn that cannot be committed changes nothing — the client gets an apology instead', async () => {
    const { convo } = await existing();
    await t.factory.staff({ role: 'consultant', email: 'c@test.local' });
    // "9" → awaiting_consultant + staff email; the email cannot be queued.
    await withFailingTrigger(t, 'jobs', () => say('9'), { when: `NEW.type = 'email.send'`, ops: 'INSERT' });
    await t.drainJobs();
    assert.equal((await convoRow(convo.id)).state, 'main_menu', 'state change rolled back with the turn');
    assert.equal(replies().length, 1);
    assert.match(replies()[0], /Sorry, something went wrong/);
    assert.deepEqual((await messages(convo.id)).map((m) => m.direction), ['inbound', 'outbound'], 'message kept for staff');
    assert.equal(t.email.sent.length, 0);
  });

  test('staff emails are queued with the turn (email.send) and delivered by the worker', async () => {
    const { convo } = await existing();
    await t.factory.staff({ role: 'consultant', email: 'c@test.local' });
    await say('9');
    assert.equal((await t.jobs('email.send')).length, 1);
    assert.ok((await convoRow(convo.id)).notified_at, 'notified_at stamped in the same transaction');
    await t.drainJobs();
    assert.match(t.email.sent[0].subject, /speak to a consultant — Thandi Turn/);
    assert.match(replies()[0], /consultant/i);
  });

  test('the inbound event is marked processed in the same transaction', async () => {
    const { convo } = await existing();
    const { rows } = await t.query(
      `INSERT INTO inbound_events (meta_message_id, phone, kind, payload) VALUES ('wamid.ev1', $1, 'text', '{"body":"0"}') RETURNING id`, [PHONE]);
    await bot.handleInbound({ phoneNumber: PHONE, metaMessageId: 'wamid.ev1', body: '0', eventId: Number(rows[0].id) });
    assert.ok((await t.one('SELECT processed_at FROM inbound_events WHERE id = $1', [rows[0].id])).processed_at);
    assert.equal((await messages(convo.id)).length, 2);
  });
});

describe('shared AI gathering loop (quotation + direct order)', () => {
  for (const [flow, state, historyKey, followupsKey] of [
    ['quotation', 'quotation_ask_description', 'quotationHistory', 'quotationFollowups'],
    ['order', 'order_gathering', 'orderHistory', 'orderFollowups'],
  ]) {
    test(`${flow}: a clarifying question is asked and the history kept`, async () => {
      const { convo } = await existing(state, { [historyKey]: [], [followupsKey]: 0 });
      t.ai.set({ status: 'need_more_info', question: 'Which sizes do you need?' });
      await say('20 golf shirts');
      await t.drainJobs();
      assert.deepEqual(replies(), ['Which sizes do you need?']);
      const cv = await convoRow(convo.id);
      assert.equal(cv.state, flow === 'quotation' ? 'quotation_gathering' : 'order_gathering');
      assert.deepEqual(cv.context[historyKey], [{ role: 'client', text: '20 golf shirts' }, { role: 'bot', text: 'Which sizes do you need?' }]);
      assert.equal(cv.context[followupsKey], 1);
    });

    test(`${flow}: after the maximum follow-ups the request is finalised without asking the AI again`, async () => {
      const { convo } = await existing(state, { [historyKey]: [{ role: 'client', text: 'shirts' }], [followupsKey]: 5 });
      t.ai.set({ status: 'need_more_info', question: 'Never asked' });
      await say('all medium');
      await t.drainJobs();
      assert.ok(!replies().includes('Never asked'));
      assert.equal(t.ai.calls.filter((c) => JSON.stringify(c.body).includes('all medium')).length > 0, true, 'request finalised (parsed)');
      assert.equal((await convoRow(convo.id)).context[followupsKey], 0, 'loop reset after finalising');
    });
  }
});

describe('proof feedback reaches staff', () => {
  async function proofSetup({ owner = true } = {}) {
    const { client, convo } = await existing('proof_review');
    const staff = owner ? await t.factory.staff({ name: 'Olive Owner', email: 'owner@test.local' }) : null;
    await t.factory.staff({ role: 'consultant', email: 'pool@test.local' });
    const order = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00321', proof_status: 'sent', assigned_staff_id: staff?.id ?? null });
    await t.query(`UPDATE conversations SET context = $2 WHERE id = $1`, [convo.id, JSON.stringify({ proofOrderId: order.id })]);
    return { order, convo };
  }

  test('approve → the order owner is emailed', async () => {
    await proofSetup();
    await say('approve');
    await t.drainJobs();
    assert.match(replies().at(-1), /Proof Approved — Ref: BRQ-O-00321/);
    assert.equal(t.email.sent.length, 1);
    assert.deepEqual(t.email.sent[0].to, ['owner@test.local']);
    assert.match(t.email.sent[0].subject, /Proof approved — Order BRQ-O-00321/);
  });

  test('changes requested on an unowned order → the consultants are emailed with the notes', async () => {
    await proofSetup({ owner: false });
    await say('revise');
    await say('Please make the logo bigger');
    await t.drainJobs();
    assert.equal(t.email.sent.length, 1);
    assert.deepEqual(t.email.sent[0].to, ['pool@test.local']);
    assert.match(t.email.sent[0].text, /Requested changes: Please make the logo bigger/);
  });
});

describe('webhook → inbound_events → inbound.process', () => {
  const textMsg = (id, body, from = PHONE) => ({ from, id, type: 'text', text: { body } });
  const payload = (messages = [], statuses = []) => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { messages, statuses } }] }],
  });

  test('events are stored once and processed in order per sender', async () => {
    const { convo } = await existing();
    const events = webhook.extractEvents(payload([textMsg('w1', '1'), textMsg('w2', 'back'), textMsg('w3', '2')]));
    assert.deepEqual(await webhook.persistEvents(events), { queued: 3, duplicates: 0, statuses: 0 });
    assert.deepEqual(await webhook.persistEvents(events), { queued: 0, duplicates: 3, statuses: 0 }, 'Meta retry');
    assert.deepEqual((await t.jobs('inbound.process')).map((j) => j.queue_key), [`wa:${PHONE}`, `wa:${PHONE}`, `wa:${PHONE}`]);

    await t.drainJobs();
    const rows = await messages(convo.id);
    assert.deepEqual(rows.filter((m) => m.direction === 'inbound').map((m) => m.body), ['1', 'back', '2']);
    assert.equal(replies().length, 3);
    assert.equal((await convoRow(convo.id)).state, 'corporate_menu');
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM inbound_events WHERE processed_at IS NULL')).n, 0);
  });

  test('media and unsupported types; empty text is ignored', async () => {
    const events = webhook.extractEvents(payload([
      { from: PHONE, id: 'm1', type: 'image', image: { caption: 'look' } },
      { from: PHONE, id: 'm2', type: 'reaction', reaction: {} },
      textMsg('m3', '   '),
    ]));
    assert.deepEqual(events.messages.map((m) => [m.metaMessageId, m.kind]), [['m1', 'image']]);
    await webhook.persistEvents(events);
    await t.drainJobs();
    const { rows } = await t.query(`SELECT body FROM messages WHERE direction = 'inbound'`);
    assert.deepEqual(rows.map((r) => r.body), ['[image received] look']);
  });

  test('delivery receipts update messages.status and never move backwards', async () => {
    const { convo } = await existing();
    await say('0');
    await t.drainJobs();
    const metaId = t.wa.sent[0].id;
    const receipt = (status) => webhook.persistEvents(webhook.extractEvents(payload([], [{ id: metaId, status }])));
    await receipt('read');
    await receipt('delivered');
    await t.drainJobs();
    const out = (await messages(convo.id)).find((m) => m.direction === 'outbound');
    assert.equal(out.status, 'read');
    await receipt('failed');
    await t.drainJobs();
    assert.equal((await messages(convo.id)).find((m) => m.direction === 'outbound').status, 'failed');
  });
});
