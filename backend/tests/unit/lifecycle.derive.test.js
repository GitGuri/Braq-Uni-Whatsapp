import './_setup.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

const { deriveJob, saToday } = await import(src('modules/lifecycle/derive.js'));
const { JOB_STATES } = await import(src('modules/lifecycle/machines.js'));

const NOW = new Date('2026-10-21T10:00:00Z');
const STAFF = 'staff-1';
const q = (o = {}) => ({ status: 'sent', past_validity: false, is_expired: false, assigned_staff_id: STAFF, sla_remind_at: null, ...o });
const order = (o = {}) => ({
  stage: 'deposit_pending', payment_status: 'unpaid', proof_status: 'none', is_on_hold: false,
  estimated_completion_date: null, assigned_staff_id: STAFF, cancelled_at: null, ...o,
});
const state = (input) => deriveJob({ now: NOW, ...input }).state;
const flags = (input) => deriveJob({ now: NOW, ...input }).flags;

describe('deriveJob — states', () => {
  test('quotation-only states', () => {
    assert.equal(state({ quotation: q({ status: 'draft' }) }), 'PRICING');
    assert.equal(state({ quotation: q({ status: 'sent' }) }), 'QUOTED');
    assert.equal(state({ quotation: q({ status: 'sent', past_validity: true }) }), 'EXPIRED');
    assert.equal(state({ quotation: q({ status: 'sent', is_expired: true }) }), 'EXPIRED');
    assert.equal(state({ quotation: q({ status: 'expired' }) }), 'EXPIRED');
    assert.equal(state({ quotation: q({ status: 'rejected' }) }), 'DECLINED');
    assert.equal(state({ quotation: q({ status: 'accepted' }) }), 'ACCEPTED');
  });

  test('order states before production', () => {
    const quotation = q({ status: 'accepted' });
    assert.equal(state({ quotation, order: order() }), 'AWAITING_DEPOSIT');
    assert.equal(state({ quotation, order: order({ proof_status: 'sent' }) }), 'AWAITING_DEPOSIT', 'deposit comes first');
    assert.equal(state({ quotation, order: order({ payment_status: 'deposit_paid', proof_status: 'sent' }) }), 'AWAITING_PROOF');
    assert.equal(state({ quotation, order: order({ payment_status: 'deposit_paid', proof_status: 'revision_requested' }) }), 'AWAITING_PROOF');
    assert.equal(state({ quotation, order: order({ payment_status: 'deposit_paid', proof_status: 'approved' }) }), 'READY_TO_PRODUCE');
    assert.equal(state({ quotation, order: order({ payment_status: 'paid_in_full' }) }), 'READY_TO_PRODUCE');
    assert.equal(state({ quotation, order: order({ payment_status: 'not_required' }) }), 'READY_TO_PRODUCE');
  });

  test('account clients skip the deposit: straight to ready to produce (or the proof)', () => {
    const quotation = q({ status: 'accepted' });
    assert.equal(state({ quotation, order: order({ account_terms: true }) }), 'READY_TO_PRODUCE');
    assert.equal(state({ quotation, order: order({ account_terms: true, proof_status: 'sent' }) }), 'AWAITING_PROOF');
    assert.equal(state({ quotation, order: order({ account_terms: false }) }), 'AWAITING_DEPOSIT');
  });

  test('production, ready, completed, after-sales, cancelled', () => {
    assert.equal(state({ order: order({ stage: 'in_production' }) }), 'IN_PRODUCTION');
    assert.equal(state({ order: order({ stage: 'ready' }) }), 'READY');
    assert.equal(state({ order: order({ stage: 'completed' }) }), 'COMPLETED');
    assert.equal(state({ order: order({ stage: 'completed' }), openTickets: 1 }), 'AFTER_SALES');
    assert.equal(state({ order: order({ stage: 'ready' }), openTickets: 2 }), 'READY', 'tickets only matter after completion');
    assert.equal(state({ order: order({ stage: 'cancelled' }) }), 'CANCELLED');
    assert.equal(state({ order: order({ cancelled_at: new Date() }) }), 'CANCELLED');
  });

  test('legacy stages map onto the pipeline', () => {
    assert.equal(state({ order: order({ stage: 'manufacturing' }) }), 'IN_PRODUCTION');
    assert.equal(state({ order: order({ stage: 'packing_dispatch' }) }), 'READY');
    assert.equal(state({ order: order({ stage: 'po_received' }) }), 'AWAITING_DEPOSIT');
    assert.equal(state({ order: order({ stage: 'po_received', payment_status: 'deposit_paid' }) }), 'READY_TO_PRODUCE');
  });

  test('every derived state is a declared job state', () => {
    const inputs = [
      { quotation: q({ status: 'draft' }) }, { quotation: q() }, { quotation: q({ status: 'expired' }) },
      { quotation: q({ status: 'rejected' }) }, { quotation: q({ status: 'accepted' }) },
      { order: order() }, { order: order({ payment_status: 'deposit_paid', proof_status: 'sent' }) },
      { order: order({ payment_status: 'deposit_paid' }) }, { order: order({ stage: 'in_production' }) },
      { order: order({ stage: 'ready' }) }, { order: order({ stage: 'completed' }) },
      { order: order({ stage: 'completed' }), openTickets: 1 }, { order: order({ stage: 'cancelled' }) },
    ];
    const seen = new Set(inputs.map(state));
    for (const s of seen) assert.ok(JOB_STATES[s], s);
    assert.equal(seen.size, Object.keys(JOB_STATES).length, 'all job states reachable');
  });
});

describe('deriveJob — flags', () => {
  test('ON_HOLD and WITH_CONSULTANT (only while the client waits for a person)', () => {
    assert.deepEqual(flags({ order: order({ is_on_hold: true }) }), ['ON_HOLD']);
    assert.deepEqual(flags({ quotation: q(), conversation: { state: 'awaiting_consultant' } }), ['WITH_CONSULTANT']);
    assert.deepEqual(flags({ quotation: q(), conversation: { state: 'consultant_active' } }), [], 'a consultant is already replying');
    assert.deepEqual(flags({ quotation: q(), conversation: { state: 'awaiting_consultant', is_open: false } }), [], 'closed chat');
    assert.deepEqual(flags({ quotation: q(), conversation: { state: 'main_menu' } }), []);
  });

  test('OVERDUE: pricing SLA breached', () => {
    assert.ok(flags({ quotation: q({ status: 'draft', sla_remind_at: new Date(NOW - 60_000) }) }).includes('OVERDUE'));
    assert.ok(!flags({ quotation: q({ status: 'draft', sla_remind_at: new Date(+NOW + 60_000) }) }).includes('OVERDUE'));
    assert.ok(!flags({ quotation: q({ status: 'sent', sla_remind_at: new Date(NOW - 60_000) }) }).includes('OVERDUE'), 'only while pricing');
  });

  test('OVERDUE: due date passed on an active order (SA calendar; strings and pg DATEs)', () => {
    assert.equal(saToday(NOW), '2026-10-21');
    assert.ok(flags({ order: order({ stage: 'in_production', estimated_completion_date: '2026-10-20' }) }).includes('OVERDUE'));
    assert.ok(!flags({ order: order({ stage: 'in_production', estimated_completion_date: '2026-10-21' }) }).includes('OVERDUE'), 'due today is not overdue');
    assert.ok(flags({ order: order({ stage: 'in_production', estimated_completion_date: new Date(2026, 9, 1) }) }).includes('OVERDUE'));
    assert.ok(!flags({ order: order({ stage: 'completed', estimated_completion_date: '2020-01-01' }) }).includes('OVERDUE'), 'completed is never overdue');
  });

  test('BALANCE_DUE (not OVERDUE): ready with balance owed', () => {
    const owed = flags({ order: order({ stage: 'ready', payment_status: 'deposit_paid' }) });
    assert.ok(owed.includes('BALANCE_DUE'));
    assert.ok(!owed.includes('OVERDUE'), 'money owed is not a missed deadline');
    assert.ok(!flags({ order: order({ stage: 'ready', payment_status: 'paid_in_full' }) }).includes('BALANCE_DUE'));
    assert.ok(!flags({ order: order({ stage: 'in_production', payment_status: 'deposit_paid' }) }).includes('BALANCE_DUE'), 'only once ready');
    assert.ok(flags({ order: order({ stage: 'ready', payment_status: 'deposit_paid', estimated_completion_date: '2026-10-01' }) }).includes('OVERDUE'),
      'a passed due date is still overdue');
  });

  test('OVERDUE: an accepted quote past its validity with no order yet', () => {
    assert.ok(flags({ quotation: q({ status: 'accepted', past_validity: true }) }).includes('OVERDUE'));
    assert.ok(!flags({ quotation: q({ status: 'accepted', past_validity: false }) }).includes('OVERDUE'));
  });

  test('UNASSIGNED: no owner on an active job (order owner, else quotation owner)', () => {
    assert.ok(flags({ quotation: q({ assigned_staff_id: null }) }).includes('UNASSIGNED'));
    assert.ok(!flags({ quotation: q({ assigned_staff_id: null }), order: order() }).includes('UNASSIGNED'), 'order owner counts');
    assert.ok(flags({ quotation: q({ assigned_staff_id: null }), order: order({ assigned_staff_id: null }) }).includes('UNASSIGNED'));
    for (const status of ['rejected', 'expired']) {
      assert.ok(!flags({ quotation: q({ status, assigned_staff_id: null }) }).includes('UNASSIGNED'), status);
    }
    assert.ok(!flags({ order: order({ stage: 'completed', assigned_staff_id: null }) }).includes('UNASSIGNED'));
  });
});
