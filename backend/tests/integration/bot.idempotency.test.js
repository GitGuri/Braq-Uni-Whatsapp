// DAT-2 / MSG-4: a replayed bot turn must not create a second ticket, quotation or
// direct order. A replay is what happens when the worker dies after a turn's
// domain write committed but before the turn's own transaction did (deploy,
// crash, lock reclaim): the inbound event is processed again from the old state.
//
// replay(): run the event once, then put the world back the way it is after such
// a crash (conversation state / inbound message / processed_at not committed —
// the domain records stay), and run the same event again.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const bot = await t.load('modules/bot/router.js');
const quotes = await t.load('modules/quotations/service.js');
const orders = await t.load('modules/orders/service.js');
const tickets = await t.load('modules/tickets/service.js');
const reminders = await t.load('workers/handlers/reminder.scan.js');
const reply = await t.load('modules/bot/reply.js');

const PHONE = '27820000888';
let seq = 0;

beforeEach(() => t.reset());
after(() => t.stop());

async function setup(state, context = {}) {
  const client = await t.factory.client({ whatsapp_number: PHONE, name: 'Rita Replay', client_type: 'corporate', profile_complete: true });
  const convo = await t.factory.conversation({ client_id: client.id, state, context });
  await t.factory.staff({ role: 'consultant', email: 'c@test.local' });
  return { client, convo };
}

async function inboundEvent(body) {
  const metaMessageId = `wamid.replay.${++seq}`;
  const { id } = await t.one(
    `INSERT INTO inbound_events (meta_message_id, phone, kind, payload) VALUES ($1, $2, 'text', $3::jsonb) RETURNING id`,
    [metaMessageId, PHONE, JSON.stringify({ body })]);
  return { eventId: Number(id), metaMessageId, body };
}

const run = (ev) => bot.handleInbound({ phoneNumber: PHONE, metaMessageId: ev.metaMessageId, body: ev.body, eventId: ev.eventId });

/** Run the event, roll the turn's own effects back (as if it never committed), run it again. */
async function replay(ev, convo) {
  const before = await t.one('SELECT state, context FROM conversations WHERE id = $1', [convo.id]);
  await run(ev);
  await t.query('UPDATE conversations SET state = $2, context = $3::jsonb WHERE id = $1', [convo.id, before.state, JSON.stringify(before.context)]);
  await t.query('DELETE FROM messages WHERE conversation_id = $1', [convo.id]);
  await t.query(`DELETE FROM jobs WHERE type IN ('whatsapp.send', 'email.send')`);
  await t.query('UPDATE inbound_events SET processed_at = NULL WHERE id = $1', [ev.eventId]);
  await run(ev);
}

const count = async (table) => (await t.one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;

describe('DAT-2 replayed bot turns', () => {
  test('ticket: one ticket, the replay re-sends the confirmation and the staff email', async () => {
    const { convo } = await setup('ticket_ask_description', { ticketCategory: 'defective' });
    const ev = await inboundEvent('The zip on two of the jackets broke on the first day of wearing them');
    await replay(ev, convo);
    assert.equal(await count('tickets'), 1);
    const ticket = await t.one('SELECT * FROM tickets');
    assert.equal(Number(ticket.source_event_id), ev.eventId);
    assert.ok(ticket.notified_at, 'staff notified by the turn that did commit');
    assert.equal((await t.one('SELECT state FROM conversations WHERE id = $1', [convo.id])).state, 'awaiting_consultant');
  });

  test('direct order: one quotation + one order; the replay confirms the same order', async () => {
    const items = [{ name: 'Golf shirt', quantity: 10, unitPrice: 100, sizes: [{ size: 'L', qty: 10 }] }];
    const { convo } = await setup('order_confirm_direct', { pendingOrderItems: items });
    const ev = await inboundEvent('yes');
    await replay(ev, convo);
    assert.equal(await count('orders'), 1);
    assert.equal(await count('quotations'), 1);
    const order = await t.one('SELECT reference FROM orders');
    await t.drainJobs();
    const texts = t.wa.texts(PHONE);
    assert.ok(texts.some((m) => m.includes(order.reference)), 'the client is told the (one) order reference');
  });

  test('direct order: a second "yes" after a failed turn cannot order twice (pending items consumed with the order)', async () => {
    const items = [{ name: 'Golf shirt', quantity: 5, unitPrice: 100 }];
    const { client, convo } = await setup('order_confirm_direct', { pendingOrderItems: items });
    await orders.placeDirectOrder(client.id, items, { conversationId: convo.id, sourceEventId: 999001 });
    // The turn failed after the order committed; the conversation is still waiting for "yes".
    const ctx = (await t.one('SELECT context FROM conversations WHERE id = $1', [convo.id])).context;
    assert.equal(ctx.pendingOrderItems, undefined, 'consumed in the order transaction');
    await run(await inboundEvent('yes'));
    assert.equal(await count('orders'), 1);
  });

  test('quotation (service): the same event twice → one quotation, one AI parse', async () => {
    const { client, convo } = await setup('main_menu');
    t.ai.set({ items: [], unmatchedText: ['50 custom embroidered caps'] });
    const a = await quotes.createFromFreeText(client.id, '50 custom embroidered caps', { conversationId: convo.id, sourceEventId: 4242 });
    const aiCalls = t.ai.calls.length;
    const b = await quotes.createFromFreeText(client.id, '50 custom embroidered caps', { conversationId: convo.id, sourceEventId: 4242 });
    assert.equal(b.quotation.id, a.quotation.id);
    assert.equal(b.replayed, true);
    assert.equal(t.ai.calls.length, aiCalls, 'no second AI call on a replay');
    assert.equal(await count('quotations'), 1);
  });

  test('without an event id (staff tools, old callers) nothing changes: every call creates', async () => {
    const { client } = await setup('main_menu');
    await tickets.createTicket({ clientId: client.id, category: 'other', description: 'one' });
    await tickets.createTicket({ clientId: client.id, category: 'other', description: 'two' });
    assert.equal(await count('tickets'), 2);
  });
});

describe('MSG-1 a staff change made while a bot turn runs is never overwritten', () => {
  async function turnOn(convo, client) {
    const turn = reply.createTurn({ phoneNumber: PHONE, metaMessageId: `wamid.race.${++seq}` });
    turn.bind({ ...convo }, client, 'hello');
    turn.setState('main_menu', { from: 'bot' });
    turn.reply(() => 'Bot reply');
    return turn;
  }

  test('consultant takes over mid-turn → the bot neither resets the state nor talks over them', async () => {
    const { client, convo } = await setup('awaiting_consultant');
    const turn = await turnOn(convo, client);
    const staff = await t.factory.staff({ role: 'consultant' });
    await t.query(`UPDATE conversations SET state = 'consultant_active', assigned_staff_id = $2 WHERE id = $1`, [convo.id, staff.id]);
    await turn.commit();
    const row = await t.one('SELECT state, context FROM conversations WHERE id = $1', [convo.id]);
    assert.equal(row.state, 'consultant_active');
    assert.equal(row.context.from, undefined, 'turn context not merged');
    const msgs = (await t.query('SELECT direction, body FROM messages WHERE conversation_id = $1', [convo.id])).rows;
    assert.deepEqual(msgs.map((m) => m.direction), ['inbound'], 'client message kept for staff; no bot reply');
  });

  test('no concurrent change → the turn applies as before', async () => {
    const { client, convo } = await setup('retail_menu');
    const turn = await turnOn(convo, client);
    await turn.commit();
    assert.equal((await t.one('SELECT state FROM conversations WHERE id = $1', [convo.id])).state, 'main_menu');
    assert.equal((await t.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [convo.id])).rows.length, 1);
  });
});

describe('MSG-4 orphaned bot records are picked up by the reminder scan', () => {
  test('a bot-made draft / ticket whose staff email never went out is reminded after 2 hours; staff-made ones are not', async () => {
    const { client } = await setup('main_menu');
    await t.query(
      `INSERT INTO quotations (reference, client_id, status, line_items, source_event_id, created_at)
       VALUES ('BRQ-Q-ORPHAN', $1, 'draft', '[]', 777, NOW() - INTERVAL '3 hours')`, [client.id]);
    await t.query(
      `INSERT INTO tickets (client_id, category, description, source_event_id, created_at, sla_due_at)
       VALUES ($1, 'other', 'orphan', 778, NOW() - INTERVAL '3 hours', NOW() + INTERVAL '1 hour')`, [client.id]);
    // Legacy rows without an event and without notified_at stay quiet (no reminder flood on deploy).
    await t.query(
      `INSERT INTO quotations (reference, client_id, status, line_items, created_at)
       VALUES ('BRQ-Q-LEGACY', $1, 'draft', '[]', NOW() - INTERVAL '30 days')`, [client.id]);
    const counts = await reminders.checkUnclaimed();
    assert.deepEqual([counts.quotations, counts.tickets], [1, 1]);
    const { rows } = await t.query(`SELECT reference FROM quotations WHERE staff_reminder_sent_at IS NOT NULL`);
    assert.deepEqual(rows.map((r) => r.reference), ['BRQ-Q-ORPHAN']);
  });
});
