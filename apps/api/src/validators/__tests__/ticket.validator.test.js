import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTicket } from '../ticket.validator.js';

const LONG_DESC = 'The blue polo shirt received on Friday was the wrong size — we ordered XL but received M for all 20 units.';

describe('validateTicket', () => {
  it('passes a complete general enquiry ticket', () => {
    const result = validateTicket({ category: 'general_enquiry', description: LONG_DESC });
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
  });

  it('fails when category is missing', () => {
    const result = validateTicket({ description: LONG_DESC });
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('category'));
  });

  it('fails when description is absent', () => {
    const result = validateTicket({ category: 'general_enquiry' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('description')));
  });

  it('fails when description is only whitespace', () => {
    const result = validateTicket({ category: 'general_enquiry', description: '   ' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('description')));
  });

  it('fails when description is too short (< 30 chars)', () => {
    const result = validateTicket({ category: 'general_enquiry', description: 'Wrong size.' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('too brief')));
  });

  it('passes when description is exactly 30 characters', () => {
    const result = validateTicket({ category: 'general_enquiry', description: 'a'.repeat(30) });
    assert.equal(result.complete, true);
  });

  it('fails wrong_item category without order_id', () => {
    const result = validateTicket({ category: 'wrong_item', description: LONG_DESC });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('order_id')));
  });

  it('passes wrong_item category with order_id', () => {
    const result = validateTicket({ category: 'wrong_item', description: LONG_DESC, order_id: 'ord_123' });
    assert.equal(result.complete, true);
  });

  it('fails defective category without order_id', () => {
    const result = validateTicket({ category: 'defective', description: LONG_DESC });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('order_id')));
  });

  it('fails missing_item category without order_id', () => {
    const result = validateTicket({ category: 'missing_item', description: LONG_DESC });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('order_id')));
  });

  it('does not require order_id for non-product-issue categories', () => {
    const result = validateTicket({ category: 'delivery_query', description: LONG_DESC });
    assert.equal(result.complete, true);
  });
});
