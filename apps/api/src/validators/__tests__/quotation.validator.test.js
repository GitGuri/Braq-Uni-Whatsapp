import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuotation } from '../quotation.validator.js';

const GOOD_ITEM = {
  name: 'Polo Shirt',
  description: 'Classic polo',
  quantity: 50,
  sizes: ['S', 'M', 'L'],
  branding: true,
  productId: 'prod_001',
};

describe('validateQuotation', () => {
  it('passes a fully valid single-item quotation', () => {
    const result = validateQuotation({ line_items: [GOOD_ITEM] });
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
    assert.equal(result.hasUnmatched, false);
  });

  it('fails when line_items is empty array', () => {
    const result = validateQuotation({ line_items: [] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('at least one line item'));
  });

  it('fails when line_items is absent', () => {
    const result = validateQuotation({});
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('at least one line item'));
  });

  it('fails when item has no description or name', () => {
    const item = { ...GOOD_ITEM, name: '', description: '' };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('description/name')));
  });

  it('fails when quantity is zero', () => {
    const item = { ...GOOD_ITEM, quantity: 0 };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('quantity')));
  });

  it('fails when sizes is an empty array', () => {
    const item = { ...GOOD_ITEM, sizes: [] };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('sizes')));
  });

  it('accepts sizes as a non-empty string', () => {
    const item = { ...GOOD_ITEM, sizes: 'S, M, L, XL' };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, true);
  });

  it('accepts sizes on the alternative `size` field', () => {
    const item = { ...GOOD_ITEM, sizes: undefined, size: 'XL' };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, true);
  });

  it('fails when branding is undefined', () => {
    const item = { ...GOOD_ITEM, branding: undefined };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('branding')));
  });

  it('accepts branding = false', () => {
    const item = { ...GOOD_ITEM, branding: false };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, true);
  });

  it('accepts branding = "yes"', () => {
    const item = { ...GOOD_ITEM, branding: 'yes' };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.complete, true);
  });

  it('sets hasUnmatched = true when productId is missing', () => {
    const item = { ...GOOD_ITEM, productId: undefined };
    const result = validateQuotation({ line_items: [item] });
    assert.equal(result.hasUnmatched, true);
    assert.equal(result.complete, false);
    assert.ok(result.warnings.some(w => w.includes('draft')));
  });

  it('aggregates issues across multiple items', () => {
    const bad1 = { ...GOOD_ITEM, quantity: 0 };
    const bad2 = { ...GOOD_ITEM, sizes: [], productId: undefined };
    const result = validateQuotation({ line_items: [bad1, bad2] });
    assert.equal(result.lineItemIssues.length, 2);
    assert.equal(result.complete, false);
  });
});
