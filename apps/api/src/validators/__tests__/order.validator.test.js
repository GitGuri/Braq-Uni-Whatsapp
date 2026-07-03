import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrder } from '../order.validator.js';

const BASE_QUOTATION = {
  line_items: [{ quantity: 10 }],
  status: 'sent',
  total: 5000,
};

const BASE_CLIENT = {
  preferred_store_location: 'Sunninghill',
};

const GATE_ORDER = {
  stage: 'quotation_submitted',
  payment_status: 'deposit_required',
};

describe('validateOrder', () => {
  it('auto-passes for pre-gate stages (no enforcement)', () => {
    const result = validateOrder({ stage: 'new_enquiry' });
    assert.equal(result.complete, true);
    assert.equal(result.canAdvance, true);
  });

  it('auto-passes for quotation_pending stage', () => {
    const result = validateOrder({ stage: 'quotation_pending' });
    assert.equal(result.complete, true);
  });

  it('fails at gate when no quotation and no line_items', () => {
    const result = validateOrder({ ...GATE_ORDER, quotation_id: null, line_items: [] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('quotation')));
  });

  it('passes at gate with quotation object provided', () => {
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1' },
      { sizeEntries: [{ size: 'M' }], quotation: BASE_QUOTATION, client: BASE_CLIENT },
    );
    assert.equal(result.complete, true);
    assert.equal(result.canAdvance, true);
  });

  it('fails when size entries empty and sizes_tbc_by is not set', () => {
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1', sizes_tbc_by: null },
      { sizeEntries: [], quotation: BASE_QUOTATION, client: BASE_CLIENT },
    );
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('size roster')));
  });

  it('passes when sizes_tbc_by is set to a future date', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1', sizes_tbc_by: future },
      { sizeEntries: [], quotation: BASE_QUOTATION, client: BASE_CLIENT },
    );
    assert.equal(result.complete, true);
  });

  it('fails when payment_status is not_required but quotation is linked', () => {
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1', payment_status: 'not_required' },
      { sizeEntries: [{ size: 'M' }], quotation: BASE_QUOTATION, client: BASE_CLIENT },
    );
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('payment_status')));
  });

  it('fails when no delivery info on order or client', () => {
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1' },
      { sizeEntries: [{ size: 'M' }], quotation: BASE_QUOTATION, client: {} },
    );
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('delivery')));
  });

  it('passes with physical_address on client as delivery info', () => {
    const client = { physical_address: '12 Oak Ave, Sandton' };
    const result = validateOrder(
      { ...GATE_ORDER, quotation_id: 'q1' },
      { sizeEntries: [{ size: 'M' }], quotation: BASE_QUOTATION, client },
    );
    assert.equal(result.complete, true);
  });

  it('passes at a post-gate stage (manufacturing) with full data', () => {
    const result = validateOrder(
      { stage: 'manufacturing', quotation_id: 'q1', payment_status: 'deposit_paid' },
      { sizeEntries: [{ size: 'L' }], quotation: BASE_QUOTATION, client: BASE_CLIENT },
    );
    assert.equal(result.complete, true);
  });
});
