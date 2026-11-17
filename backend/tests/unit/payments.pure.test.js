// Pure payment-state maths of the payments module (no database).
import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

let svc;
before(async () => { svc = await import(src('modules/payments/service.js')); });

// ── computePaymentState (pure) ───────────────────────────────────────────────
describe('computePaymentState', () => {
  const st = (order, paidBeforeCents, amountCents, type = 'deposit', quotationTotal = null) =>
    svc.computePaymentState({ order, paidBeforeCents, amountCents, type, quotationTotal });
  const priced = { payment_status: 'unpaid', deposit_amount: '600.00', balance_amount: '400.00' };

  test('deposit reached → deposit_paid; balance stays total − deposit', () => {
    const r = st(priced, 0, 60000);
    assert.equal(r.status, 'deposit_paid');
    assert.equal(r.balanceCents, 40000);
    assert.equal(r.outstandingCents, 40000);
  });

  test('partial deposit → status unchanged, deposit still due', () => {
    const r = st(priced, 0, 25000);
    assert.equal(r.status, 'unpaid');
    assert.equal(r.depositDueCents, 35000);
    assert.equal(r.balanceCents, 40000);
  });

  test('beyond deposit → balance is what is still owed', () => {
    const r = st({ ...priced, payment_status: 'deposit_paid' }, 60000, 10000, 'balance');
    assert.equal(r.status, 'deposit_paid');
    assert.equal(r.balanceCents, 30000);
  });

  test('total recovered from balance + max(paid, deposit) after earlier payments', () => {
    // after 700 paid on a 1000 order the stored balance is 300
    const r = st({ ...priced, payment_status: 'deposit_paid', balance_amount: '300.00' }, 70000, 30000, 'balance');
    assert.equal(r.totalCents, 100000);
    assert.equal(r.status, 'paid_in_full');
    assert.equal(r.balanceCents, 0);
  });

  test('overpayment → 400', () => {
    assert.throws(() => st(priced, 60000, 50000, 'balance'), (e) => e.status === 400 && /R 400\.00/.test(e.message));
    assert.throws(() => st({ ...priced, payment_status: 'paid_in_full', balance_amount: '0' }, 100000, 1), (e) => e.status === 400);
  });

  test('quotation total used when the order has no deposit/balance amounts', () => {
    const r = st({ payment_status: 'unpaid' }, 0, 10000, 'deposit', '1000.00');
    assert.equal(r.totalCents, 100000);
    assert.equal(r.status, 'deposit_paid');
    assert.equal(r.balanceCents, 90000);
    assert.throws(() => st({ payment_status: 'unpaid' }, 0, 100001, 'full', '1000.00'), (e) => e.status === 400);
  });

  test('no total known: type decides; paid_in_full cannot be paid again', () => {
    assert.equal(st({ payment_status: 'unpaid' }, 0, 100, 'deposit').status, 'deposit_paid');
    assert.equal(st({ payment_status: 'unpaid' }, 0, 100, 'balance').status, 'paid_in_full');
    assert.equal(st({ payment_status: 'deposit_paid' }, 100, 100, 'full').status, 'paid_in_full');
    assert.throws(() => st({ payment_status: 'paid_in_full' }, 100, 100, 'deposit'), (e) => e.status === 400);
  });

  test('never downgrades: a deposit after deposit_paid stays deposit_paid', () => {
    assert.equal(st({ payment_status: 'deposit_paid' }, 100, 100, 'deposit').status, 'deposit_paid');
  });
});

describe('orderTotalCents', () => {
  test('deposit/balance bookkeeping first, then the quotation total, else null', () => {
    assert.equal(svc.orderTotalCents({ deposit_amount: '600', balance_amount: '400' }, 0), 100000);
    assert.equal(svc.orderTotalCents({ deposit_amount: '600', balance_amount: '300' }, 70000), 100000);
    assert.equal(svc.orderTotalCents({}, 0, '250.50'), 25050);
    assert.equal(svc.orderTotalCents({}, 0, '0'), null);
    assert.equal(svc.orderTotalCents({}, 0, null), null);
  });
});
