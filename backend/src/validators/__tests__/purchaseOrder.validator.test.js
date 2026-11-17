import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchaseOrder } from '../purchaseOrder.validator.js';

const GOOD_PO = {
  quotation_id: 'q_abc123',
  po_number: 'PO-2026-001',
  amount: 10000,
};

const GOOD_QUOTATION = {
  status: 'sent',
  total: 10000,
  valid_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

describe('validatePurchaseOrder', () => {
  it('passes a valid PO without quotation object', () => {
    const result = validatePurchaseOrder(GOOD_PO);
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.warnings, []);
  });

  it('passes a valid PO with a matching quotation', () => {
    const result = validatePurchaseOrder(GOOD_PO, GOOD_QUOTATION);
    assert.equal(result.complete, true);
    assert.deepEqual(result.warnings, []);
  });

  it('fails when both quotation_id and quotation_reference are absent', () => {
    const result = validatePurchaseOrder({ po_number: 'PO-001' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('quotation_id')));
  });

  it('passes using quotation_reference instead of quotation_id', () => {
    const result = validatePurchaseOrder({ quotation_reference: 'Q-2026-005', po_number: 'PO-002' });
    assert.equal(result.complete, true);
  });

  it('fails when po_number is missing', () => {
    const result = validatePurchaseOrder({ quotation_id: 'q1' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('po_number')));
  });

  it('fails when po_number is only whitespace', () => {
    const result = validatePurchaseOrder({ quotation_id: 'q1', po_number: '   ' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('po_number')));
  });

  it('fails when quotation status is draft', () => {
    const result = validatePurchaseOrder(GOOD_PO, { ...GOOD_QUOTATION, status: 'draft' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('status')));
  });

  it('fails when quotation status is expired', () => {
    const result = validatePurchaseOrder(GOOD_PO, { ...GOOD_QUOTATION, status: 'expired' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('status')));
  });

  it('passes when quotation status is accepted', () => {
    const result = validatePurchaseOrder(GOOD_PO, { ...GOOD_QUOTATION, status: 'accepted' });
    assert.equal(result.complete, true);
  });

  it('fails when quotation valid_until is in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = validatePurchaseOrder(GOOD_PO, { ...GOOD_QUOTATION, valid_until: past });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('expired')));
  });

  it('issues a warning when PO amount differs > 5% from quotation total', () => {
    const result = validatePurchaseOrder(
      { ...GOOD_PO, amount: 9000 },
      GOOD_QUOTATION,
    );
    assert.equal(result.complete, true);
    assert.ok(result.warnings.some(w => w.includes('differs')));
  });

  it('no warning when PO amount is within 5% of quotation total', () => {
    const result = validatePurchaseOrder(
      { ...GOOD_PO, amount: 10049 },
      GOOD_QUOTATION,
    );
    assert.equal(result.complete, true);
    assert.deepEqual(result.warnings, []);
  });

  it('no warning when PO amount is absent', () => {
    const result = validatePurchaseOrder(
      { quotation_id: 'q1', po_number: 'PO-001' },
      GOOD_QUOTATION,
    );
    assert.equal(result.complete, true);
    assert.deepEqual(result.warnings, []);
  });
});
