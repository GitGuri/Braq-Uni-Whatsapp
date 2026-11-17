import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateClientProfile, validateClientForOrder } from '../client.validator.js';

// ── validateClientProfile ────────────────────────────────────────────────────

describe('validateClientProfile', () => {
  it('passes a fully-populated retail client', () => {
    const result = validateClientProfile({ name: 'John Doe', client_type: 'retail' });
    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
  });

  it('fails when name is missing', () => {
    const result = validateClientProfile({ name: '', client_type: 'retail' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m === 'name'));
  });

  it('fails when name is only whitespace', () => {
    const result = validateClientProfile({ name: '   ', client_type: 'retail' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('name'));
  });

  it('fails when client_type is missing', () => {
    const result = validateClientProfile({ name: 'Jane' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('client_type'));
  });

  it('fails corporate client without organisation', () => {
    const result = validateClientProfile({ name: 'ACME Corp', client_type: 'corporate' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('organisation')));
  });

  it('passes corporate client with organisation set', () => {
    const result = validateClientProfile({ name: 'Jane', client_type: 'corporate', organisation: 'ACME Ltd' });
    assert.equal(result.complete, true);
  });

  it('passes school client with school_name instead of organisation', () => {
    const result = validateClientProfile({ name: 'Mary', client_type: 'school', school_name: 'Greenside High' });
    assert.equal(result.complete, true);
  });

  it('fails school client with neither organisation nor school_name', () => {
    const result = validateClientProfile({ name: 'Mary', client_type: 'school' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('organisation or school_name')));
  });

  it('does not require organisation for retail client type', () => {
    const result = validateClientProfile({ name: 'John', client_type: 'retail' });
    assert.equal(result.complete, true);
  });
});

// ── validateClientForOrder ───────────────────────────────────────────────────

describe('validateClientForOrder', () => {
  const base = { name: 'Jane', client_type: 'retail' };

  it('fails when delivery info is completely absent', () => {
    const result = validateClientForOrder(base);
    assert.equal(result.complete, false);
    assert.ok(result.missing.some(m => m.includes('delivery_preference')));
  });

  it('passes with preferred_store_location', () => {
    const result = validateClientForOrder({ ...base, preferred_store_location: 'Sunninghill' });
    assert.equal(result.complete, true);
  });

  it('passes with physical_address', () => {
    const result = validateClientForOrder({ ...base, physical_address: '1 Main Rd, Sandton' });
    assert.equal(result.complete, true);
  });

  it('passes with delivery_preference column (Phase 5 field)', () => {
    const result = validateClientForOrder({ ...base, delivery_preference: 'delivery' });
    assert.equal(result.complete, true);
  });

  it('inherits profile failures alongside delivery failure', () => {
    const result = validateClientForOrder({ name: '', client_type: 'retail' });
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('name'));
    assert.ok(result.missing.some(m => m.includes('delivery_preference')));
  });
});
