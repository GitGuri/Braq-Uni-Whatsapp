import './_setup.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

const G = await import(src('modules/lifecycle/guards.js'));

const order = (o = {}) => ({ is_on_hold: false, proof_status: 'none', payment_status: 'unpaid', ...o });
const codes = (o, to) => G.advanceGuards(order(o), to).map((g) => g.code);
const ADMIN = { role: 'admin' }, MANAGER = { role: 'manager' }, CONSULTANT = { role: 'consultant' };

describe('advanceGuards', () => {
  test('→ in_production: deposit required, proof pending (sent / revision_requested)', () => {
    assert.deepEqual(codes({}, 'in_production'), ['DEPOSIT_REQUIRED']);
    assert.deepEqual(codes({ payment_status: 'deposit_paid' }, 'in_production'), []);
    assert.deepEqual(codes({ payment_status: 'paid_in_full' }, 'in_production'), []);
    assert.deepEqual(codes({ payment_status: 'not_required' }, 'in_production'), []);
    assert.deepEqual(codes({ payment_status: 'deposit_paid', proof_status: 'sent' }, 'in_production'), ['PROOF_PENDING']);
    assert.deepEqual(codes({ proof_status: 'revision_requested' }, 'in_production'), ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
    assert.deepEqual(codes({ payment_status: 'deposit_paid', proof_status: 'approved' }, 'in_production'), []);
    const [proof] = G.advanceGuards(order({ payment_status: 'deposit_paid', proof_status: 'revision_requested' }), 'in_production');
    assert.match(proof.message, /revisions/);
  });

  test('account clients: no deposit needed before production; the balance still is before completion', () => {
    assert.deepEqual(codes({ account_terms: true }, 'in_production'), []);
    assert.deepEqual(codes({ account_terms: true, proof_status: 'sent' }, 'in_production'), ['PROOF_PENDING']);
    assert.deepEqual(codes({ account_terms: true }, 'completed'), ['BALANCE_DUE']);
    assert.deepEqual(codes({ account_terms: true, is_on_hold: true }, 'in_production'), ['HOLD']);
  });

  test('→ ready: only HOLD applies (pending proof does not block later stages)', () => {
    assert.deepEqual(codes({ proof_status: 'sent' }, 'ready'), []);
    assert.deepEqual(codes({ is_on_hold: true }, 'ready'), ['HOLD']);
  });

  test('→ completed: balance due unless paid in full', () => {
    assert.deepEqual(codes({ payment_status: 'deposit_paid' }, 'completed'), ['BALANCE_DUE']);
    assert.deepEqual(codes({ payment_status: 'paid_in_full' }, 'completed'), []);
    assert.deepEqual(codes({ payment_status: 'not_required' }, 'completed'), []);
  });

  test('HOLD comes first and is not overridable; the others are', () => {
    const all = G.advanceGuards(order({ is_on_hold: true, proof_status: 'sent' }), 'in_production');
    assert.deepEqual(all.map((g) => [g.code, g.overridable]), [['HOLD', false], ['PROOF_PENDING', true], ['DEPOSIT_REQUIRED', true]]);
    assert.equal(G.checkAdvance(order({ is_on_hold: true }), 'ready').code, 'HOLD');
    assert.deepEqual(G.checkAdvance(order({ payment_status: 'paid_in_full' }), 'completed'), { ok: true });
  });
});

describe('evaluateAdvance (overrides and roles)', () => {
  test('no blocking guard → ok, nothing overridden (override ignored)', () => {
    assert.deepEqual(G.evaluateAdvance(order({ payment_status: 'deposit_paid' }), 'in_production'), { ok: true, overridden: [] });
    assert.equal(G.evaluateAdvance(order({ payment_status: 'deposit_paid' }), 'in_production', { override: { reason: 'x' }, staff: CONSULTANT }).ok, true);
  });

  test('blocked without override → 409 { code, overridable: true, guards, blockers }', () => {
    const r = G.evaluateAdvance(order(), 'in_production', { staff: MANAGER });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {
      error: G.GUARDS.DEPOSIT_REQUIRED.message, code: 'DEPOSIT_REQUIRED', overridable: true, guards: ['DEPOSIT_REQUIRED'],
      blockers: [{ code: 'DEPOSIT_REQUIRED', message: G.GUARDS.DEPOSIT_REQUIRED.message, overridable: true }],
    });
  });

  test('every blocking guard is listed with its message (the override dialog shows them all)', () => {
    const r = G.evaluateAdvance(order({ proof_status: 'sent' }), 'in_production', { staff: MANAGER });
    assert.deepEqual(r.body.guards, ['PROOF_PENDING', 'DEPOSIT_REQUIRED']);
    assert.deepEqual(r.body.blockers.map((b) => [b.code, b.message, b.overridable]), [
      ['PROOF_PENDING', G.GUARDS.PROOF_PENDING.message, true],
      ['DEPOSIT_REQUIRED', G.GUARDS.DEPOSIT_REQUIRED.message, true],
    ]);
  });

  test('HOLD → 409 overridable:false, even with a manager override', () => {
    for (const override of [null, { reason: 'urgent customer' }]) {
      const r = G.evaluateAdvance(order({ is_on_hold: true }), 'ready', { override, staff: ADMIN });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'HOLD');
      assert.equal(r.body.overridable, false);
    }
  });

  test('override reason shorter than 5 characters → 400', () => {
    for (const reason of ['', '   ', 'abcd', ' ab ', undefined]) {
      const r = G.evaluateAdvance(order(), 'in_production', { override: { reason }, staff: MANAGER });
      assert.equal(r.status, 400, JSON.stringify(reason));
      assert.equal(r.body.code, 'OVERRIDE_REASON_REQUIRED');
    }
  });

  test('consultant cannot override → 403; admin and manager can', () => {
    const c = G.evaluateAdvance(order(), 'in_production', { override: { reason: 'client paid cash' }, staff: CONSULTANT });
    assert.equal(c.status, 403);
    assert.equal(c.body.code, 'OVERRIDE_FORBIDDEN');
    assert.equal(G.evaluateAdvance(order(), 'in_production', { override: { reason: 'client paid cash' }, staff: null }).status, 403);
    for (const staff of [ADMIN, MANAGER]) {
      const r = G.evaluateAdvance(order({ proof_status: 'sent' }), 'in_production', { override: { reason: '  client paid cash  ' }, staff });
      assert.deepEqual(r, { ok: true, overridden: ['PROOF_PENDING', 'DEPOSIT_REQUIRED'], reason: 'client paid cash' });
    }
    assert.deepEqual(G.evaluateAdvance(order({ payment_status: 'deposit_paid' }), 'completed', { override: { reason: 'account client' }, staff: MANAGER }).overridden, ['BALANCE_DUE']);
  });
});
