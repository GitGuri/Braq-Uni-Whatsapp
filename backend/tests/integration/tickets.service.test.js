// tickets service against a real Postgres: the ticket machine, resolution note,
// clearing the assignee, the client's "resolved" WhatsApp (queued with the
// update), staff-created tickets and the bot's ticket → order linking rule.
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const svc = await t.load('modules/tickets/service.js');

beforeEach(() => t.reset());
after(() => t.stop());

const ticket = async (o = {}) => {
  const client = o.client ?? await t.factory.client({ whatsapp_number: o.wa ?? '27824440000' });
  return t.one(`INSERT INTO tickets (client_id, order_id, category, description, sla_due_at, status, assigned_staff_id)
                VALUES ($1, $2, 'defective', 'Seams split', now() + interval '4 hours', $3, $4) RETURNING *`,
  [client.id, o.order_id ?? null, o.status ?? 'open', o.assigned_staff_id ?? null]);
};

describe('updateTicket', () => {
  test('resolving stores the note, stamps resolved_at and queues one WhatsApp to the client (with the order ref)', async () => {
    const client = await t.factory.client({ whatsapp_number: '27824441111' });
    const order = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00077' });
    const tk = await ticket({ client, order_id: order.id });
    const r = await svc.updateTicket(tk.id, { status: 'resolved', resolutionNote: 'Replaced 2 shirts' });
    assert.deepEqual([r.status, r.resolution_note], ['resolved', 'Replaced 2 shirts']);
    assert.ok(r.resolved_at);
    const jobs = await t.jobs('whatsapp.send');
    assert.equal(jobs.length, 1);
    await t.drainJobs();
    const [msg] = t.wa.texts('27824441111');
    assert.match(msg, /resolved\* — Order BRQ-O-00077/);
    assert.ok(msg.includes('Replaced 2 shirts'));
    const [ev] = (await t.query('SELECT type, data FROM job_events WHERE order_id = $1', [order.id])).rows;
    assert.equal(ev.type, 'ticket.resolved');
    // resolved → closed keeps resolved_at and does not notify again
    const closed = await svc.updateTicket(tk.id, { status: 'closed' });
    assert.equal(closed.resolved_at.getTime(), r.resolved_at.getTime());
    assert.equal((await t.jobs('whatsapp.send')).length, 1);
  });

  test('ticket machine: allowed moves pass, refused moves are 409 with a code; same status is idempotent', async () => {
    const tk = await ticket({ status: 'closed' });
    await assert.rejects(svc.updateTicket(tk.id, { status: 'resolved' }), (e) => e.status === 409 && e.extra.code === 'TICKET_TRANSITION');
    assert.equal((await svc.updateTicket(tk.id, { status: 'open' })).status, 'open');
    assert.equal((await svc.updateTicket(tk.id, { status: 'open' })).status, 'open');
    assert.equal((await svc.updateTicket(tk.id, { status: 'in_progress' })).resolved_at, null);
    await assert.rejects(svc.updateTicket(tk.id, { status: 'done' }), (e) => e.status === 400);
  });

  test('assignedStaffId: set (active staff only), then null clears it; empty update → 400; unknown ticket → 404', async () => {
    const staff = await t.factory.staff();
    const inactive = await t.factory.staff({ is_active: false });
    const tk = await ticket();
    assert.equal((await svc.updateTicket(tk.id, { assignedStaffId: staff.id })).assigned_staff_id, staff.id);
    await assert.rejects(svc.updateTicket(tk.id, { assignedStaffId: inactive.id }), (e) => e.status === 400);
    const cleared = await svc.updateTicket(tk.id, { assignedStaffId: null });
    assert.deepEqual([cleared.assigned_staff_id, cleared.claimed_at], [null, null]);
    await assert.rejects(svc.updateTicket(tk.id, {}), (e) => e.status === 400);
    await assert.rejects(svc.updateTicket('00000000-0000-4000-8000-000000000000', { status: 'open' }), (e) => e.status === 404);
  });

  test('no WhatsApp number → resolved without a message', async () => {
    const tk = await ticket({ wa: '' });
    await svc.updateTicket(tk.id, { status: 'resolved' });
    assert.equal((await t.jobs()).length, 0);
  });
});

describe('getTicketById / listTickets / createTicketByStaff', () => {
  test('ticket shows its order reference, quotation id and the client conversation', async () => {
    const client = await t.factory.client();
    const quote = await t.factory.quotation({ client_id: client.id, status: 'accepted' });
    const order = await t.factory.order({ client_id: client.id, quotation_id: quote.id, reference: 'BRQ-O-00088' });
    const convo = await t.factory.conversation({ client_id: client.id });
    const tk = await ticket({ client, order_id: order.id });
    const r = await svc.getTicketById(tk.id);
    assert.deepEqual([r.order_reference, r.quotation_id, r.conversation_id], ['BRQ-O-00088', quote.id, convo.id]);
    const list = await svc.listTickets({ orderId: order.id });
    assert.deepEqual([list.total, list.items[0].id, list.items[0].quotation_id], [1, tk.id, quote.id]);
  });

  test('staff-created ticket is assigned to the creator; the order must belong to the client', async () => {
    const staff = await t.factory.staff();
    const client = await t.factory.client();
    const other = await t.factory.client();
    const order = await t.factory.order({ client_id: client.id });
    const tk = await svc.createTicketByStaff({ clientId: client.id, orderId: order.id, category: 'other', description: 'Call back' }, staff);
    assert.deepEqual([tk.assigned_staff_id, tk.order_id, tk.status], [staff.id, order.id, 'open']);
    await assert.rejects(svc.createTicketByStaff({ clientId: other.id, orderId: order.id, category: 'other', description: 'x' }, staff), (e) => e.status === 400);
    await assert.rejects(svc.createTicketByStaff({ clientId: '00000000-0000-4000-8000-000000000000', category: 'other', description: 'x' }, staff), (e) => e.status === 400);
  });
});

describe('findOrderForTicket (bot linking rule)', () => {
  test('quoted reference (own orders only) → single active order → most recent when none active → null when ambiguous', async () => {
    const client = await t.factory.client();
    const stranger = await t.factory.client();
    assert.equal(await svc.findOrderForTicket(client.id, 'anything'), null, 'no orders');
    const done = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00101', stage: 'completed' });
    assert.equal((await svc.findOrderForTicket(client.id, 'no ref')).id, done.id, 'most recent when nothing is active');
    const active = await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00102', stage: 'in_production' });
    assert.equal((await svc.findOrderForTicket(client.id, 'no ref')).id, active.id, 'the single active order');
    assert.equal((await svc.findOrderForTicket(client.id, 'about brq-o-00101 please')).id, done.id, 'a quoted reference wins');
    await t.factory.order({ client_id: client.id, reference: 'BRQ-O-00103', stage: 'ready' });
    assert.equal(await svc.findOrderForTicket(client.id, 'no ref'), null, 'two active orders → ambiguous');
    const theirs = await t.factory.order({ client_id: stranger.id, reference: 'BRQ-O-00104' });
    const r = await svc.findOrderForTicket(client.id, 'BRQ-O-00104');
    assert.notEqual(r?.id, theirs.id, "never another client's order");
  });
});
