// Pure helpers of the orders module (no database).
import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

let svc;
before(async () => { svc = await import(src('modules/orders/service.js')); });

// ── getStageInfo ──────────────────────────────────────────────────────────────
describe('getStageInfo', () => {
  const cases = [
    ['deposit_pending', { index: 0, total: 4, percent: 25, label: 'deposit_pending', isFirst: true, isLast: false }],
    ['in_production', { index: 1, total: 4, percent: 50, label: 'in_production', isFirst: false, isLast: false }],
    ['ready', { index: 2, total: 4, percent: 75, label: 'ready', isFirst: false, isLast: false }],
    ['completed', { index: 3, total: 4, percent: 100, label: 'completed', isFirst: false, isLast: true }],
    // legacy stage names map onto the 4-stage pipeline
    ['manufacturing', { index: 1, total: 4, percent: 50, label: 'in_production', isFirst: false, isLast: false }],
    ['po_received', { index: 0, total: 4, percent: 25, label: 'deposit_pending', isFirst: true, isLast: false }],
    ['packing_dispatch', { index: 2, total: 4, percent: 75, label: 'ready', isFirst: false, isLast: false }],
    ['teleporting', { index: -1, total: 4, percent: null, label: 'unknown', isFirst: false, isLast: false }],
    [undefined, { index: -1, total: 4, percent: null, label: 'unknown', isFirst: false, isLast: false }],
  ];
  for (const [stage, expected] of cases) {
    test(`${stage}`, () => assert.deepEqual(svc.getStageInfo(stage), expected));
  }
});

describe('formatDate', () => {
  for (const [input, expected] of [
    ['2026-11-05', '5 Nov 2026'],
    ['2026-11-05T00:00:00.000Z', '5 Nov 2026'],
    [new Date(2026, 10, 1), '1 Nov 2026'],
    ['', null],
    [null, null],
    ['not a date', null],
  ]) {
    test(`${String(input)} → ${expected}`, () => assert.equal(svc.formatDate(input), expected));
  }
});

describe('toCanonicalStage', () => {
  test('canonical stages map to themselves; legacy names to the 4-stage pipeline; unknown → null', () => {
    assert.equal(svc.toCanonicalStage('ready'), 'ready');
    assert.equal(svc.toCanonicalStage('manufacturing'), 'in_production');
    assert.equal(svc.toCanonicalStage('packing_dispatch'), 'ready');
    assert.equal(svc.toCanonicalStage('teleporting'), null);
  });
});
