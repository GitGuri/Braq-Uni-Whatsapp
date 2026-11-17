import './_setup.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

const { nextActions, oneClickAction, ACTION_LABELS } = await import(src('modules/lifecycle/nextActions.js'));
const { buildLifecycle, orderMoney } = await import(src('modules/lifecycle/index.js'));

const ADMIN = { role: 'admin' }, MANAGER = { role: 'manager' }, CONSULTANT = { role: 'consultant' };
const Q = { id: 'q1', status: 'sent', total: '1150.00', assigned_staff_id: 's1' };
const O = (o = {}) => ({ id: 'o1', client_id: 'c1', stage: 'deposit_pending', payment_status: 'unpaid', proof_status: 'none', is_on_hold: false, assigned_staff_id: 's1', ...o });
const MONEY = { depositCents: 69000, totalCents: 115000, paidCents: 0 };

const keys = (acts) => acts.map((a) => a.key);
const primary = (acts) => acts.filter((a) => a.primary).map((a) => a.key);
const find = (acts, key) => acts.find((a) => a.key === key);

function run(state, { order = null, quotation = Q, money = {}, flags = [], openTickets = [] } = {}, staff = CONSULTANT) {
  return nextActions({ state, flags, quotation, order, money, openTickets }, staff);
}

describe('nextActions per state', () => {
  test('PRICING → price & send quote (lineItems input); decline', () => {
    const a = run('PRICING', { quotation: { ...Q, status: 'draft' } });
    assert.deepEqual(keys(a), ['price_quote', 'mark_declined']);
    assert.deepEqual(primary(a), ['price_quote']);
    assert.equal(find(a, 'price_quote').inputs[0].name, 'lineItems');
    assert.deepEqual(find(a, 'price_quote').endpoint, { method: 'POST', path: '/api/quotations/q1/approve' });
  });

  test('QUOTED → "Client accepted — create order" in one step (primary, optional PO), resend, decline, revise', () => {
    const a = run('QUOTED');
    assert.deepEqual(keys(a), ['accept_and_order', 'resend_quote', 'mark_declined', 'revise_quote']);
    assert.deepEqual(primary(a), ['accept_and_order']);
    assert.equal(find(a, 'accept_and_order').label, 'Client accepted — create order');
    assert.deepEqual(find(a, 'accept_and_order').endpoint, { method: 'POST', path: '/api/orders/convert-from-quotation/q1', body: { accept: true } });
    assert.deepEqual(find(a, 'accept_and_order').inputs.map((i) => [i.name, i.required, i.label]), [['poNumber', false, 'Purchase order number']]);
    assert.deepEqual(find(a, 'revise_quote').endpoint.body, { status: 'draft' });
    assert.deepEqual(find(a, 'mark_declined').endpoint.body, { status: 'rejected' });
  });

  test('EXPIRED / DECLINED → revise', () => {
    for (const s of ['EXPIRED', 'DECLINED']) assert.deepEqual(keys(run(s)), ['revise_quote']);
  });

  test('ACCEPTED → create order (primary) with an optional PO number (no owner field: the creator owns it)', () => {
    const a = run('ACCEPTED', { quotation: { ...Q, status: 'accepted' } });
    assert.deepEqual(keys(a), ['create_order', 'mark_declined']);
    assert.deepEqual(primary(a), ['create_order']);
    assert.deepEqual(find(a, 'create_order').inputs.map((i) => [i.name, i.required]), [['poNumber', false]]);
    assert.deepEqual(find(a, 'create_order').endpoint, { method: 'POST', path: '/api/orders/convert-from-quotation/q1' });
  });

  test('AWAITING_DEPOSIT → record deposit prefilled with the deposit due (+ "Start production now"); start production disabled (DEPOSIT_REQUIRED)', () => {
    const a = run('AWAITING_DEPOSIT', { order: O(), money: { ...MONEY, paidCents: 10000 } });
    assert.deepEqual(keys(a), ['record_deposit', 'send_proof', 'start_production']);
    assert.deepEqual(primary(a), ['record_deposit']);
    const amount = find(a, 'record_deposit').inputs.find((i) => i.name === 'amount');
    assert.equal(amount.default, 590, '690 deposit − 100 paid');
    // The deposit clears the last block (no proof out): offer "Start production now" + due date.
    assert.deepEqual(find(a, 'record_deposit').inputs.map((i) => i.name), ['amount', 'type', 'notes', 'startProduction', 'estimatedCompletion']);
    assert.equal(find(a, 'record_deposit').inputs.find((i) => i.name === 'estimatedCompletion').showIf, 'startProduction');
    const start = find(a, 'start_production');
    assert.equal(start.enabled, false);
    assert.equal(start.code, 'DEPOSIT_REQUIRED');
    assert.match(start.reason, /deposit/);
    assert.equal(start.requiresOverride, true);
    assert.deepEqual(start.blockers, [{ code: 'DEPOSIT_REQUIRED', message: start.reason, overridable: true }]);
  });

  test('AWAITING_DEPOSIT with a proof out → approve design instead of send proof; no "start now" (two blocks)', () => {
    const a = run('AWAITING_DEPOSIT', { order: O({ proof_status: 'sent' }), money: MONEY });
    assert.deepEqual(keys(a), ['record_deposit', 'mark_proof_approved', 'start_production']);
    assert.ok(!find(a, 'record_deposit').inputs.some((i) => i.name === 'startProduction'), 'the proof still blocks');
    assert.ok(!find(a, 'mark_proof_approved').inputs.some((i) => i.name === 'startProduction'), 'the deposit still blocks');
    assert.deepEqual(find(a, 'start_production').blockers.map((b) => b.code), ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
  });

  test('AWAITING_PROOF → approve design (primary, + "Start production now"), changes requested, new proof; start production blocked by PROOF_PENDING', () => {
    const a = run('AWAITING_PROOF', { order: O({ payment_status: 'deposit_paid', proof_status: 'sent' }), money: MONEY });
    assert.deepEqual(keys(a), ['mark_proof_approved', 'mark_proof_revision', 'send_proof', 'start_production']);
    assert.deepEqual(primary(a), ['mark_proof_approved']);
    assert.equal(find(a, 'mark_proof_approved').label, 'Approve design');
    assert.deepEqual(find(a, 'mark_proof_approved').inputs.map((i) => i.name), ['notes', 'startProduction', 'estimatedCompletion']);
    assert.equal(find(a, 'start_production').code, 'PROOF_PENDING');
    const rev = run('AWAITING_PROOF', { order: O({ payment_status: 'deposit_paid', proof_status: 'revision_requested' }) });
    assert.deepEqual(keys(rev), ['mark_proof_approved', 'send_proof', 'start_production']);
  });

  test('READY_TO_PRODUCE → start production (primary, due date input)', () => {
    const a = run('READY_TO_PRODUCE', { order: O({ payment_status: 'deposit_paid' }), money: MONEY });
    assert.deepEqual(keys(a), ['start_production', 'send_proof']);
    assert.deepEqual(primary(a), ['start_production']);
    assert.equal(find(a, 'start_production').enabled, true);
    assert.equal(find(a, 'start_production').inputs[0].name, 'estimatedCompletion');
    assert.deepEqual(find(a, 'start_production').endpoint, { method: 'POST', path: '/api/orders/o1/advance' });
  });

  test('IN_PRODUCTION → mark ready (collection/delivery + tracking); record balance while owed', () => {
    const a = run('IN_PRODUCTION', { order: O({ stage: 'in_production', payment_status: 'deposit_paid' }), money: { ...MONEY, paidCents: 69000 } });
    assert.deepEqual(keys(a), ['mark_ready', 'record_balance']);
    assert.deepEqual(find(a, 'mark_ready').inputs.find((i) => i.name === 'deliveryType').options, ['collection', 'delivery']);
    assert.equal(find(a, 'record_balance').inputs[0].default, 460);
    const paid = run('IN_PRODUCTION', { order: O({ stage: 'in_production', payment_status: 'paid_in_full' }), money: { ...MONEY, paidCents: 115000 } });
    assert.deepEqual(keys(paid), ['mark_ready']);
  });

  test('READY with balance owed → mark collected (primary) with "Balance received now" prefilled', () => {
    const a = run('READY', { order: O({ stage: 'ready', payment_status: 'deposit_paid' }), money: { ...MONEY, paidCents: 69000 } });
    assert.deepEqual(keys(a), ['mark_collected']);
    assert.deepEqual(primary(a), ['mark_collected']);
    const c = find(a, 'mark_collected');
    assert.equal(c.enabled, true);
    assert.equal(c.balanceDue, 460);
    assert.deepEqual(c.inputs.map((i) => [i.name, i.type, i.required, i.default]), [['balanceAmount', 'money', false, 460], ['notes', 'text', false, undefined]]);
    assert.deepEqual(c.endpoint, { method: 'POST', path: '/api/orders/o1/advance' });
  });

  test('READY paid in full → mark collected primary (no balance field); "Mark delivered" for deliveries', () => {
    const a = run('READY', { order: O({ stage: 'ready', payment_status: 'paid_in_full' }), money: { ...MONEY, paidCents: 115000 } });
    assert.deepEqual(keys(a), ['mark_collected']);
    assert.equal(find(a, 'mark_collected').enabled, true);
    assert.deepEqual(primary(a), ['mark_collected']);
    assert.deepEqual(find(a, 'mark_collected').inputs.map((i) => i.name), ['notes']);
    const d = run('READY', { order: O({ stage: 'ready', payment_status: 'paid_in_full', delivery_type: 'delivery' }), money: { ...MONEY, paidCents: 115000 } });
    assert.equal(find(d, 'mark_collected').label, 'Mark delivered');
  });

  test('account clients: approving the design without a deposit offers "Start production now"; no deposit guard', () => {
    const a = run('AWAITING_PROOF', { order: O({ proof_status: 'sent', account_terms: true }), money: MONEY });
    assert.ok(find(a, 'mark_proof_approved').inputs.some((i) => i.name === 'startProduction'));
    const b = run('READY_TO_PRODUCE', { order: O({ account_terms: true }), money: MONEY });
    assert.equal(find(b, 'start_production').enabled, true);
  });

  test('COMPLETED → open ticket; AFTER_SALES → resolve each open ticket + open ticket', () => {
    assert.deepEqual(keys(run('COMPLETED', { order: O({ stage: 'completed' }) })), ['open_ticket']);
    const a = run('AFTER_SALES', { order: O({ stage: 'completed' }), openTickets: [{ id: 't1' }, { id: 't2' }] });
    assert.deepEqual(keys(a), ['resolve_ticket', 'resolve_ticket', 'open_ticket']);
    assert.deepEqual(a.filter((x) => x.key === 'resolve_ticket').map((x) => x.ticketId), ['t1', 't2']);
    assert.deepEqual(primary(a), ['resolve_ticket']);
    assert.deepEqual(find(a, 'resolve_ticket').endpoint, { method: 'PATCH', path: '/api/tickets/t1', body: { status: 'resolved' } });
  });

  test('open tickets can be resolved in any state (secondary there)', () => {
    const a = run('IN_PRODUCTION', { order: O({ stage: 'in_production', payment_status: 'deposit_paid' }), money: MONEY, openTickets: [{ id: 't9' }] });
    const r = find(a, 'resolve_ticket');
    assert.equal(r.ticketId, 't9');
    assert.equal(r.primary, false);
    assert.deepEqual(primary(a), ['mark_ready']);
  });

  test('ON_HOLD → release hold is the primary action; stage moves explain the hold (not overridable)', () => {
    const a = run('READY_TO_PRODUCE', { order: O({ payment_status: 'deposit_paid', is_on_hold: true }), flags: ['ON_HOLD'] }, ADMIN);
    assert.equal(a[0].key, 'release_hold');
    assert.deepEqual(primary(a), ['release_hold']);
    const start = find(a, 'start_production');
    assert.equal(start.enabled, false);
    assert.equal(start.code, 'HOLD');
    assert.equal(start.requiresOverride, false);
    assert.equal(start.overrideAllowed, false);
  });

  test('every action has a label; at most one primary', () => {
    for (const s of ['PRICING', 'QUOTED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'READY', 'COMPLETED']) {
      const a = run(s, { order: s.startsWith('A') && s !== 'ACCEPTED' ? O() : O({ stage: 'ready' }), money: MONEY });
      for (const x of a) assert.equal(x.label, ACTION_LABELS[x.key], x.key);
      assert.ok(a.filter((x) => x.primary).length <= 1, s);
    }
  });
});

describe('nextActions per role', () => {
  test('override allowed for admin / manager only', () => {
    for (const [staff, allowed] of [[ADMIN, true], [MANAGER, true], [CONSULTANT, false], [null, false]]) {
      const start = find(run('AWAITING_DEPOSIT', { order: O(), money: MONEY }, staff), 'start_production');
      assert.equal(start.overrideAllowed, allowed, staff?.role ?? 'anonymous');
      const proof = find(run('AWAITING_PROOF', { order: O({ proof_status: 'sent', payment_status: 'deposit_paid' }), money: MONEY }, staff), 'start_production');
      assert.equal(proof.overrideAllowed, allowed);
    }
  });

  test('no separate "record purchase order" step for anyone (the PO number goes on create order)', () => {
    for (const staff of [ADMIN, MANAGER, CONSULTANT]) {
      for (const s of ['QUOTED', 'ACCEPTED']) assert.equal(find(run(s, {}, staff), 'record_po'), undefined, `${s} ${staff.role}`);
    }
  });
});

describe('oneClickAction (dashboard / board rows)', () => {
  test('primary actions with nothing to fill in are one-click; required or prefilled inputs are not', () => {
    assert.deepEqual(oneClickAction(run('QUOTED')), {
      key: 'accept_and_order', label: 'Client accepted — create order',
      endpoint: { method: 'POST', path: '/api/orders/convert-from-quotation/q1', body: { accept: true } },
    });
    assert.equal(oneClickAction(run('ACCEPTED', { quotation: { ...Q, status: 'accepted' } })).key, 'create_order');
    assert.equal(oneClickAction(run('READY_TO_PRODUCE', { order: O({ payment_status: 'deposit_paid' }), money: MONEY })).key, 'start_production');
    assert.equal(oneClickAction(run('AWAITING_PROOF', { order: O({ payment_status: 'deposit_paid', proof_status: 'sent' }), money: MONEY })).key, 'mark_proof_approved');
    assert.equal(oneClickAction(run('PRICING', { quotation: { ...Q, status: 'draft' } })), null, 'needs line items');
    assert.equal(oneClickAction(run('AWAITING_DEPOSIT', { order: O(), money: MONEY })), null, 'needs an amount');
    assert.equal(oneClickAction(run('IN_PRODUCTION', { order: O({ stage: 'in_production', payment_status: 'deposit_paid' }), money: MONEY })), null, 'collection or delivery');
    assert.equal(oneClickAction(run('READY', { order: O({ stage: 'ready', payment_status: 'deposit_paid' }), money: { ...MONEY, paidCents: 69000 } })), null, 'balance to check');
    assert.equal(oneClickAction(run('READY', { order: O({ stage: 'ready', payment_status: 'paid_in_full' }), money: { ...MONEY, paidCents: 115000 } })).key, 'mark_collected');
    const t = oneClickAction(run('AFTER_SALES', { order: O({ stage: 'completed' }), openTickets: [{ id: 't1' }] }));
    assert.deepEqual([t.key, t.ticketId], ['resolve_ticket', 't1']);
    assert.equal(oneClickAction([]), null);
  });
});

describe('buildLifecycle / orderMoney', () => {
  test('orderMoney: total_amount, else balance + max(paid, deposit), else quotation total', () => {
    assert.deepEqual(orderMoney({ total_amount: '1150.00', deposit_amount: '690.00', balance_amount: '460.00' }, [{ amount: '100.00' }]),
      { depositCents: 69000, totalCents: 115000, paidCents: 10000 });
    assert.equal(orderMoney({ deposit_amount: '600', balance_amount: '400' }, []).totalCents, 100000);
    assert.equal(orderMoney({ deposit_amount: null, balance_amount: null }, [], { total: '50' }).totalCents, 5000);
    assert.equal(orderMoney({}, [], null).totalCents, null);
    assert.deepEqual(orderMoney(null), {});
  });

  test('buildLifecycle returns { state, label, flags, nextActions }', () => {
    const lc = buildLifecycle({
      quotation: { ...Q, status: 'accepted' },
      order: O({ total_amount: '1150.00', deposit_amount: '690.00', balance_amount: '460.00' }),
      payments: [], tickets: [{ id: 't', status: 'resolved' }], conversation: { state: 'awaiting_consultant' },
    }, MANAGER);
    assert.equal(lc.state, 'AWAITING_DEPOSIT');
    assert.equal(lc.label, 'Awaiting deposit');
    assert.deepEqual(lc.flags, ['WITH_CONSULTANT']);
    assert.equal(lc.nextActions[0].key, 'record_deposit');
    assert.equal(lc.nextActions[0].inputs[0].default, 690);
    assert.equal(lc.nextActions.find((a) => a.key === 'start_production').overrideAllowed, true);
  });

  test('only open / in-progress tickets make a completed job AFTER_SALES', () => {
    const order = O({ stage: 'completed', payment_status: 'paid_in_full' });
    assert.equal(buildLifecycle({ order, tickets: [{ id: 't', status: 'closed' }] }).state, 'COMPLETED');
    assert.equal(buildLifecycle({ order, tickets: [{ id: 't', status: 'in_progress' }] }).state, 'AFTER_SALES');
  });
});
