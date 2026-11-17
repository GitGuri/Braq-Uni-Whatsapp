import './_setup.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { src } from './_setup.js';

const M = await import(src('modules/lifecycle/machines.js'));

describe('quotation machine', () => {
  const ok = (from, to, facts) => assert.equal(M.quotationTransition(from, to, facts).ok, true, `${from} → ${to}`);
  const no = (from, to, facts, code) => {
    const r = M.quotationTransition(from, to, facts);
    assert.equal(r.ok, false, `${from} → ${to} should be refused`);
    if (code) assert.equal(r.code, code);
    return r;
  };

  test('every (from, to) pair follows QUOTATION_TRANSITIONS', () => {
    for (const to of M.QUOTATION_STATUSES) {
      for (const from of M.QUOTATION_STATUSES) {
        const allowed = M.QUOTATION_TRANSITIONS[to].from.includes(from);
        assert.equal(M.quotationTransition(from, to).ok, allowed, `${from} → ${to}`);
      }
    }
  });

  test('accept: sent within validity only (expired → QUOTE_EXPIRED)', () => {
    ok('sent', 'accepted', { pastValidity: false });
    const r = no('sent', 'accepted', { pastValidity: true }, 'QUOTE_EXPIRED');
    assert.match(r.message, /from 'expired' to 'accepted' — the quotation has expired/);
    no('expired', 'accepted', {}, 'QUOTE_EXPIRED');
    no('draft', 'accepted', {}, 'INVALID_TRANSITION');
  });

  test('revise (→ draft) and decline refused once an order exists', () => {
    ok('sent', 'draft');
    ok('rejected', 'draft');
    ok('expired', 'draft');
    no('accepted', 'draft', {}, 'INVALID_TRANSITION');
    assert.match(no('rejected', 'draft', { hasOrder: true }, 'ORDER_EXISTS').message, /order already exists/);
    ok('accepted', 'rejected');
    no('accepted', 'rejected', { hasOrder: true }, 'ORDER_EXISTS');
  });

  test('unknown target → INVALID_STATUS', () => {
    no('draft', 'paid', {}, 'INVALID_STATUS');
  });

  test('canClientAccept: sent and valid only', () => {
    assert.equal(M.canClientAccept({ status: 'sent', past_validity: false }), true);
    assert.equal(M.canClientAccept({ status: 'sent', past_validity: true }), false);
    assert.equal(M.canClientAccept({ status: 'sent', is_expired: true }), false);
    for (const status of ['draft', 'accepted', 'rejected', 'expired']) assert.equal(M.canClientAccept({ status }), false, status);
    assert.equal(M.canClientAccept(null), false);
  });
});

describe('order stages', () => {
  test('canonical pipeline, labels and legacy aliases', () => {
    assert.deepEqual(M.ORDER_STAGES, ['deposit_pending', 'in_production', 'ready', 'completed']);
    assert.deepEqual(M.ORDER_STAGES.map((s) => M.STAGE_LABELS[s]), ['Awaiting deposit', 'In production', 'Ready', 'Completed']);
    assert.deepEqual(M.STAGE_META.map((s) => s.key), M.ORDER_STAGES);
    for (const [legacy, canonical] of Object.entries(M.LEGACY_STAGE_MAP)) {
      assert.equal(M.toCanonicalStage(legacy), canonical, legacy);
      assert.ok(M.ORDER_STAGES.includes(canonical));
      assert.ok(M.CLIENT_STAGE_LABELS[legacy], `client label for ${legacy}`);
    }
    assert.equal(M.toCanonicalStage('teleporting'), null);
    assert.equal(M.toCanonicalStage(undefined), null);
  });

  test('nextStage handles canonical and legacy stages', () => {
    assert.equal(M.nextStage('deposit_pending'), 'in_production');
    assert.equal(M.nextStage('in_production'), 'ready');
    assert.equal(M.nextStage('ready'), 'completed');
    assert.equal(M.nextStage('completed'), null);
    assert.equal(M.nextStage('manufacturing'), 'ready');
    assert.equal(M.nextStage('po_received'), 'in_production');
    assert.equal(M.nextStage('packing_dispatch'), 'completed');
    assert.equal(M.nextStage('bogus'), null);
    assert.equal(M.stageLabelFor('quality_control'), 'In production');
  });
});

describe('payments', () => {
  test('deposit / paid-in-full predicates (incl. legacy values)', () => {
    const cases = {
      unpaid: [false, false], deposit_required: [false, false], deposit_paid: [true, false],
      paid_in_full: [true, true], not_required: [true, true], undefined: [false, false],
    };
    for (const [status, [dep, full]] of Object.entries(cases)) {
      const s = status === 'undefined' ? undefined : status;
      assert.equal(M.isDepositPaid(s), dep, `deposit ${status}`);
      assert.equal(M.isPaidInFull(s), full, `full ${status}`);
    }
  });
});

describe('proof machine', () => {
  test('every transition in PROOF_TRANSITIONS is allowed (pre-production); everything else refused', () => {
    for (const from of M.PROOF_STATUSES) {
      for (const to of ['sent', 'approved', 'revision_requested']) {
        const expected = (M.PROOF_TRANSITIONS[from] || []).includes(to);
        assert.equal(M.proofTransition(from, to, { stage: 'deposit_pending' }).ok, expected, `${from} → ${to}`);
      }
    }
  });

  test('none → approved / revision_requested is refused; null proof status counts as none', () => {
    assert.equal(M.proofTransition('none', 'approved').code, 'PROOF_TRANSITION');
    assert.equal(M.proofTransition(null, 'sent').ok, true);
    assert.equal(M.proofTransition('revision_requested', 'approved').ok, false);
  });

  test('an approved proof can only be replaced before production', () => {
    assert.equal(M.proofTransition('approved', 'sent', { stage: 'deposit_pending' }).ok, true);
    assert.equal(M.proofTransition('approved', 'sent', { stage: 'po_received' }).ok, true, 'legacy pre-production stage');
    const r = M.proofTransition('approved', 'sent', { stage: 'in_production' });
    assert.equal(r.ok, false);
    assert.match(r.message, /production has started/);
  });

  test('invalid targets', () => {
    assert.equal(M.proofTransition('sent', 'bogus').code, 'INVALID_STATUS');
    assert.equal(M.proofTransition('sent', 'none').code, 'INVALID_STATUS');
  });
});

describe('ticket machine', () => {
  test('allowed transitions, idempotent same-status, refused others', () => {
    for (const [from, tos] of Object.entries(M.TICKET_TRANSITIONS)) {
      for (const to of M.TICKET_STATUSES) {
        const expected = from === to || tos.includes(to);
        assert.equal(M.ticketTransition(from, to).ok, expected, `${from} → ${to}`);
      }
    }
    assert.equal(M.ticketTransition('closed', 'resolved').code, 'TICKET_TRANSITION');
    assert.equal(M.ticketTransition('open', 'done').code, 'INVALID_STATUS');
  });
});

describe('conversation state sets', () => {
  test('bot states include the human hand-over and proof states; no duplicates', () => {
    for (const s of ['main_menu', 'awaiting_consultant', 'consultant_active', 'proof_review', 'order_confirm_direct', 'registration_address']) {
      assert.ok(M.BOT_STATES.includes(s), s);
    }
    assert.deepEqual([...M.HUMAN_STATES].sort(), ['awaiting_consultant', 'consultant_active']);
    assert.equal(new Set(M.BOT_STATES).size, M.BOT_STATES.length);
  });

  test('every state the bot writes or handles is a known bot state', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL(src('modules/bot')));
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'states')).map((f) => path.join(dir, 'states', f))]
      .filter((f) => f.endsWith('.js'));
    const read = (f) => fs.readFileSync(f, 'utf8');
    const all = files.map(read).join('\n');
    const stateJs = read(path.join(dir, 'state.js'));
    const router = read(path.join(dir, 'router.js'));
    const handlers = router.slice(router.indexOf('const STATE_HANDLERS = {'), router.indexOf('};', router.indexOf('const STATE_HANDLERS = {')));
    const written = new Set([
      ...[...all.matchAll(/setState\('([a-z_]+)'/g)].map((m) => m[1]),
      ...[...stateJs.matchAll(/^\s{2}([a-z_]+):\s+'[a-z_]+',?$/gm)].map((m) => m[1]),   // PARENT_STATE keys
      ...[...handlers.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]),                  // STATE_HANDLERS keys
    ]);
    assert.ok(written.size >= 25, `parsed only ${written.size} states`);
    const unknown = [...written].filter((s) => !M.BOT_STATES.includes(s));
    assert.deepEqual(unknown, []);
  });
});

describe('job states', () => {
  test('every job state has a label and description; journey and terminal states are known', () => {
    for (const [k, v] of Object.entries(M.JOB_STATES)) {
      assert.ok(v.label && v.description, k);
    }
    for (const s of [...M.JOB_JOURNEY, ...M.TERMINAL_JOB_STATES]) assert.ok(M.JOB_STATES[s], s);
  });
});
