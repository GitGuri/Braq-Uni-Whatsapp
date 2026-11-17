import './_setup.js';
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { src, assertClean } from './_setup.js';

let T, stageLabel, STAGE_ORDER, nextStage, templateForStage;
before(async () => {
  ({ TEMPLATES: T, stageLabel, STAGE_ORDER, nextStage, templateForStage } = await import(src('modules/bot/templates.js')));
});

const LONG = 'X'.repeat(5000);
const UNI = 'Zoë Ñandú — 学校 🎓 «Ünïcødé»';

// ── Zero-arg templates ────────────────────────────────────────────────────────
const ZERO_ARG = [
  'MAIN_MENU', 'RETAIL_MENU', 'CORPORATE_MENU', 'OUTSIDE_HOURS_ACK', 'HIGH_VOLUME_NOTICE',
  'RETAIL_SCHOOL_NOT_FOUND', 'RETAIL_SIZE_ASK', 'RETAIL_HOURS', 'RETAIL_LAYBY', 'RETAIL_COLLECTION_ASK',
  'CORPORATE_REPEAT_ORDER_ASK', 'CORPORATE_MANUFACTURING_ASK', 'CORPORATE_DELIVERY_ASK',
  'CORPORATE_ACCOUNT_QUERY_ASK', 'CORPORATE_ACCOUNT_QUERY_LOGGED', 'NO_PENDING_QUOTE',
  'ORDER_ASK_METHOD', 'ORDER_ASK_REFERENCE', 'ORDER_QUOTE_NOT_FOUND', 'ORDER_TRACKING_ASK',
  'REGISTRATION_ASK_DETAILS', 'TICKET_ASK_CATEGORY', 'TICKET_ASK_DESCRIPTION',
  'TICKET_LOGGED', 'TICKET_NEEDS_MORE_DETAIL', 'PAID_IN_FULL', 'AWAITING_CONSULTANT', 'UNKNOWN_INTENT',
  'ORDER_NOT_FOUND', 'BRANDING_INFO', 'STORE_INFO', 'GENERIC_ERROR', 'MEDIA_RECEIVED',
  // UX round 2
  'FAQ_ESCALATED', 'THANKS_REPLY', 'RETAIL_SIZE_UNKNOWN', 'CORPORATE_NO_PREVIOUS_ORDER', 'NO_QUOTES',
  'ORDER_NOTHING_IDENTIFIED', 'ORDER_TRACKING_NONE', 'ORDER_TRACKING_LIST', 'TICKET_PHOTO_BEFORE_LOG', 'TICKET_PHOTO_ADDED',
  'CONSULTANT_ACK', 'CONSULTANT_QUEUE', 'CONSULTANT_CANCELLED', 'ORDER_QUOTE_NOT_READY',
];

describe('zero-arg templates', () => {
  for (const key of ZERO_ARG) {
    test(`${key}() is a clean non-empty string`, () => {
      const out = T[key]();
      assertClean(assert, out, key);
      assert.ok(out.trim().length > 10, key);
    });
  }

  test('every exported template is covered by this suite', () => {
    const PARAM = [
      'RETAIL_PRODUCT_LIST', 'RETAIL_SCHOOL_SELECT', 'RETAIL_SCHOOL_UNIFORMS', 'RETAIL_COLLECTION_READY',
      'RETAIL_COLLECTION_NOT_READY', 'CORPORATE_DELIVERY_STATUS', 'QUOTATION_ASK_DESCRIPTION',
      'QUOTATION_DRAFT_ACK', 'QUOTATION_AUTO_APPROVED', 'QUOTE_ACCEPTED',
      'ORDER_CONFIRM_QUOTE', 'ORDER_ASK_ITEMS', 'ORDER_CONFIRM_DIRECT',
      'ORDER_CREATED', 'DEPOSIT_REQUIRED',
      'FREE_TEXT_ANSWER', 'RETAIL_SCHOOL_NO_CATALOG', 'RETAIL_SIZE_ANSWER', 'CORPORATE_REPEAT_OFFER',
      'OVERDUE_QUOTE_REMINDER', 'QUOTE_EXPIRED', 'QUOTE_REFRESH_REQUESTED', 'QUOTE_STATUS', 'QUOTE_CHANGES_ASK',
      'QUOTE_CHANGES_LOGGED', 'ORDER_OFFER_QUOTE', 'PROOF_CONFIRM',
      'DEPOSIT_RECEIVED', 'BALANCE_OUTSTANDING', 'STAGE_DEPOSIT_PENDING', 'STAGE_IN_PRODUCTION',
      'STAGE_READY_COLLECTION', 'STAGE_READY_DELIVERY', 'STAGE_COMPLETED', 'SUPPLIER_DELAY',
      'CONSULTANT_ASSIGNED', 'ORDER_TRACKING_RESULT', 'PROOF_SENT', 'PROOF_APPROVED',
      'PROOF_REVISION_REQUESTED', 'PROOF_REVISION_ASK', 'TICKET_RESOLVED',
    ];
    assert.deepEqual(Object.keys(T).sort(), [...ZERO_ARG, ...PARAM].sort());
  });

  test('TICKET_RESOLVED: order reference and resolution note when known, clean without them', () => {
    const full = T.TICKET_RESOLVED({ reference: 'BRQ-O-00007', note: 'Replacement shirts sent.' });
    assert.match(full, /resolved\* — Order BRQ-O-00007/);
    assert.ok(full.includes('Replacement shirts sent.'));
    assertClean(assert, T.TICKET_RESOLVED());
    assertClean(assert, T.TICKET_RESOLVED({ reference: null, note: null }));
  });

  test('trading hours text matches isWithinBusinessHours rules (Mon–Fri 8–5, Sat 8–1, Sun closed)', () => {
    for (const out of [T.RETAIL_HOURS(), T.STORE_INFO()]) {
      assert.match(out, /Mon – Fri:\s*\*?8:00 AM – 5:00 PM/);
      assert.match(out, /Saturday:\s*\*?8:00 AM – 1:00 PM/);
      assert.match(out, /Sunday & Public Holidays: \*?Closed/);
    }
  });

  test('ORDER_TRACKING_ASK example uses the new global BRQ-O-XXXXX format (diff)', () => {
    assert.match(T.ORDER_TRACKING_ASK(), /BRQ-O-\d{5}\b/);
    assert.doesNotMatch(T.ORDER_TRACKING_ASK(), /BRQ-O-\d{8}-\d{4}/);
  });
});

// ── RETAIL_PRODUCT_LIST ───────────────────────────────────────────────────────
describe('RETAIL_PRODUCT_LIST', () => {
  test('missing / null / empty products → "being updated" fallback', () => {
    for (const products of [undefined, null, []]) {
      const out = T.RETAIL_PRODUCT_LIST({ products });
      assert.match(out, /currently being updated/);
      assertClean(assert, out);
    }
  });

  test('orders known categories first, appends unknown ones, hides school_wear', () => {
    const out = T.RETAIL_PRODUCT_LIST({
      products: [
        { name: 'Zeta Jacket', category: 'zz_custom_line', price: 10 },
        { name: 'School Blazer', category: 'school_wear', price: 300 },
        { name: 'Hard Hat', category: 'safety_wear', price: '45.5' },
        { name: 'Knit Jersey', category: 'knitwear', price: 199.999, sizes: ['S', 'M'] },
        { name: 'Scrub Top', category: 'medical_wear', price: 0, sizes: [] },
      ],
    });
    assertClean(assert, out);
    const idx = (s) => out.indexOf(s);
    assert.ok(idx('*Knitwear*') < idx('*Medical Wear*'));
    assert.ok(idx('*Medical Wear*') < idx('*Safety Wear*'));
    assert.ok(idx('*Safety Wear*') < idx('*Zz Custom Line*'));
    assert.ok(!out.includes('School Blazer'), 'school_wear must be excluded');
    assert.match(out, /Knit Jersey — R 200\.00\n {2}Sizes: S, M/);
    assert.match(out, /Hard Hat — R 45\.50/);
    assert.match(out, /Scrub Top — R 0\.00\n(?! {2}Sizes)/);
  });

  test('unicode names pass through unchanged; a list too long for WhatsApp is capped with a hint', () => {
    assert.ok(T.RETAIL_PRODUCT_LIST({ products: [{ name: UNI, category: 'knitwear', price: 1 }] }).includes(UNI));
    const out = T.RETAIL_PRODUCT_LIST({ products: [{ name: UNI + LONG, category: 'knitwear', price: 1 }] });
    assert.ok(out.length < 4096, `length ${out.length}`);
    assert.match(out, /and \d+ more items/);
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `Item ${i}`, category: 'knitwear', price: i }));
    const capped = T.RETAIL_PRODUCT_LIST({ products: many });
    assert.ok(capped.length < 4096);
    assert.match(capped, /\*0\* Main menu$/);
    assert.ok(T.RETAIL_SCHOOL_SELECT({ schools: Array.from({ length: 400 }, (_, i) => `School number ${i}`) }).length < 4096);
  });
});

// ── School templates ──────────────────────────────────────────────────────────
describe('school templates', () => {
  test('RETAIL_SCHOOL_SELECT numbers schools from 1', () => {
    const out = T.RETAIL_SCHOOL_SELECT({ schools: ['A', UNI] });
    assert.match(out, /1\. A\n2\. Zoë/);
    assertClean(assert, out);
  });

  test('RETAIL_SCHOOL_SELECT with empty list still clean', () => {
    assertClean(assert, T.RETAIL_SCHOOL_SELECT({ schools: [] }));
  });

  test('RETAIL_SCHOOL_UNIFORMS renders price, sizes and optional description', () => {
    const out = T.RETAIL_SCHOOL_UNIFORMS({
      schoolName: 'Dalpark Primary',
      uniforms: [
        { name: 'Blazer', price: '450', sizes: ['28', '30'], description: 'Navy wool' },
        { name: 'Tie', price: 55.5, sizes: null, description: null },
      ],
    });
    assertClean(assert, out);
    assert.match(out, /Dalpark Primary — Available Uniforms/);
    assert.match(out, /\*Blazer\* — R 450\.00\n {2}Sizes: 28, 30\n {2}Navy wool/);
    assert.match(out, /\*Tie\* — R 55\.50\n\n/);
  });
});

// ── Reference / stage templates ───────────────────────────────────────────────
describe('reference & stage templates', () => {
  test('RETAIL_COLLECTION_READY / NOT_READY', () => {
    assert.match(T.RETAIL_COLLECTION_READY({ reference: 'BRQ-O-00001' }), /BRQ-O-00001\* is ready/);
    const nr = T.RETAIL_COLLECTION_NOT_READY({ reference: 'BRQ-O-00002', stage: 'in_production' });
    assert.match(nr, /Current stage: \*In Production\*/);
    assertClean(assert, nr);
  });

  test('CORPORATE_DELIVERY_STATUS with and without tracking number', () => {
    const a = T.CORPORATE_DELIVERY_STATUS({ reference: 'R1', stage: 'ready', trackingNumber: 'TRK9' });
    assert.match(a, /Ready \/ Dispatched/);
    assert.match(a, /Tracking number: TRK9/);
    const b = T.CORPORATE_DELIVERY_STATUS({ reference: 'R1', stage: 'ready', trackingNumber: null });
    assert.ok(!b.includes('Tracking'));
    assertClean(assert, b);
  });

  test('ORDER_TRACKING_RESULT optional fields', () => {
    const full = T.ORDER_TRACKING_RESULT({ reference: 'R', stage: 'completed', trackingNumber: 'T1', estimatedCompletion: '1 Nov 2026' });
    assert.match(full, /Completed/);
    assert.match(full, /Estimated completion: \*1 Nov 2026\*/);
    assert.match(full, /Tracking number: \*T1\*/);
    const bare = T.ORDER_TRACKING_RESULT({ reference: 'R', stage: 'deposit_pending' });
    assert.ok(!bare.includes('Estimated') && !bare.includes('Tracking'));
    assertClean(assert, bare);
  });

  test('stageLabel maps the 4 current stages and humanises unknown keys', () => {
    assert.equal(stageLabel('deposit_pending'), 'Awaiting Deposit');
    assert.equal(stageLabel('in_production'), 'In Production');
    assert.equal(stageLabel('ready'), 'Ready / Dispatched');
    assert.equal(stageLabel('completed'), 'Completed');
    assert.equal(stageLabel('weird'), 'Weird');
    assert.equal(stageLabel('some_new_stage'), 'Some New Stage');
    for (const empty of [null, undefined, '']) assertClean(assert, stageLabel(empty));
  });

  test('stageLabel for legacy stages still in the DB (seed-testing) is human readable', () => {
    for (const s of ['manufacturing', 'materials_procurement', 'quality_control', 'packing_dispatch', 'quotation_requested']) {
      assert.doesNotMatch(String(stageLabel(s)), /_/, `raw stage key "${s}" would be shown to the customer`);
    }
  });

  test('STAGE_ORDER / nextStage / templateForStage', () => {
    assert.deepEqual(STAGE_ORDER, ['deposit_pending', 'in_production', 'ready', 'completed']);
    assert.equal(nextStage('deposit_pending'), 'in_production');
    assert.equal(nextStage('in_production'), 'ready');
    assert.equal(nextStage('ready'), 'completed');
    assert.equal(nextStage('completed'), null);
    assert.equal(nextStage('nope'), null);
    assert.equal(nextStage(undefined), null);
    assert.equal(templateForStage('deposit_pending'), 'STAGE_DEPOSIT_PENDING');
    assert.equal(templateForStage('in_production'), 'STAGE_IN_PRODUCTION');
    assert.equal(templateForStage('ready'), 'STAGE_READY_COLLECTION');
    assert.equal(templateForStage('completed'), 'STAGE_COMPLETED');
    assert.equal(templateForStage('x'), null);
    for (const s of STAGE_ORDER) assert.equal(typeof T[templateForStage(s)], 'function');
  });
});

// ── Quotation flow ────────────────────────────────────────────────────────────
describe('quotation templates', () => {
  test('QUOTATION_ASK_DESCRIPTION with / without / no-arg name', () => {
    assert.match(T.QUOTATION_ASK_DESCRIPTION({ name: UNI }), /^Hi \*Zoë\*/, 'first name only');
    assert.match(T.QUOTATION_ASK_DESCRIPTION({}), /^Hi! /);
    assert.match(T.QUOTATION_ASK_DESCRIPTION(), /^Hi! /);
    assert.match(T.QUOTATION_ASK_DESCRIPTION({ name: 'Thabo Mokoena', thanks: true }), /^Thanks, \*Thabo\*! ✅/);
    // example request per kind of client
    assert.match(T.QUOTATION_ASK_DESCRIPTION({ clientType: 'retail' }), /Dalview jerseys size 10/);
    assert.match(T.QUOTATION_ASK_DESCRIPTION({ clientType: 'corporate' }), /golf shirts, logo embroidered/);
    assert.match(T.QUOTATION_ASK_DESCRIPTION({ clientType: 'school' }), /school jerseys with the crest/);
    assertClean(assert, T.QUOTATION_ASK_DESCRIPTION({ name: null }));
    assertClean(assert, T.QUOTATION_ASK_DESCRIPTION({ name: '' }));
  });

  test('QUOTATION_DRAFT_ACK with and without unmatched items', () => {
    const a = T.QUOTATION_DRAFT_ACK({ reference: 'BRQ-Q-20260101-0001', unmatched: ['50 swim caps', 'boots'] });
    assert.match(a, /checked and priced by our team:\n• 50 swim caps\n• boots\n\n/);
    const b = T.QUOTATION_DRAFT_ACK({ reference: 'Q' });
    assert.ok(!b.includes('checked and priced'));
    assert.ok(!/Reply \*9\*/.test(a), 'no "Reply 9" — it does not work while waiting for a consultant');
    assert.match(a, /We aim to do this within \*4 business hours\*/);
    assert.match(T.QUOTATION_DRAFT_ACK({ reference: 'Q', fromOrder: true }), /turned your order into a quote request/);
    assertClean(assert, a); assertClean(assert, b);
  });

  test('QUOTATION_AUTO_APPROVED / QUOTE_ACCEPTED embed reference', () => {
    assert.match(T.QUOTATION_AUTO_APPROVED({ reference: 'Q1' }), /Ref: Q1/);
    // Owner decision 1: no order is created — the consultant confirms it
    assert.match(T.QUOTE_ACCEPTED({ reference: 'Q2' }), /Ref: Q2\*\n\nThanks! Your consultant will confirm your order and send the deposit details shortly\./);
  });

  test('ORDER_QUOTE_NOT_READY branches on status — no "reply 5" dead end', () => {
    assert.match(T.ORDER_QUOTE_NOT_READY({ status: 'draft' }), /still being reviewed/);
    assert.match(T.ORDER_QUOTE_NOT_READY({ status: 'rejected' }), /already been converted/);
    assert.match(T.ORDER_QUOTE_NOT_READY(), /already been converted/);
    assert.match(T.ORDER_QUOTE_NOT_READY({ status: 'accepted', reference: 'Q', orderReference: 'BRQ-O-00009' }), /no longer available to order — it has already been converted to order \*BRQ-O-00009\*/);
    assert.match(T.ORDER_QUOTE_NOT_READY({ status: 'expired', reference: 'Q', expiredOn: '1 Oct 2026' }), /expired on 1 Oct 2026[\s\S]*Reply \*1\*/);
    for (const st of ['draft', 'rejected', 'expired', 'accepted', undefined]) assert.doesNotMatch(T.ORDER_QUOTE_NOT_READY({ status: st }), /Reply \*5\*/);
  });

  test('QUOTE_EXPIRED / QUOTE_STATUS / quote changes', () => {
    assert.equal(T.QUOTE_EXPIRED({ reference: 'BRQ-Q-1', expiredOn: '3 Oct 2026' }),
      "⌛ Quote *BRQ-Q-1* expired on 3 Oct 2026.\n\nReply *1* and we'll refresh it at today's prices.");
    assert.match(T.QUOTE_STATUS({ reference: 'Q', status: 'sent', total: 115, validUntil: '9 Nov 2026', resent: true }), /R 115\.00[\s\S]*sent the PDF again[\s\S]*valid until \*9 Nov 2026\*/);
    assert.match(T.QUOTE_STATUS({ reference: 'Q', status: 'draft' }), /still pricing/);
    assert.match(T.QUOTE_STATUS({ reference: 'Q', status: 'accepted', orderReference: 'BRQ-O-1' }), /order \*BRQ-O-1\*/);
    for (const st of ['draft', 'sent', 'accepted', 'expired', 'rejected', 'weird']) assertClean(assert, T.QUOTE_STATUS({ reference: 'Q', status: st }), st);
    assert.match(T.QUOTE_CHANGES_ASK({ reference: 'Q' }), /change on quote \*Q\*/);
    assert.match(T.QUOTE_CHANGES_LOGGED({ reference: 'Q' }), /passed your changes/);
  });
});

// ── Order confirm templates ───────────────────────────────────────────────────
describe('ORDER_CONFIRM_QUOTE / ORDER_CONFIRM_DIRECT', () => {
  const items = [
    { name: 'Polo', colour: 'Navy', quantity: 30, lineTotal: 3600, sizes: [{ size: 'S', qty: 10 }, { size: 'M', qty: 20 }] },
    { name: 'Hoodie', quantity: 2, unitPrice: 199.995, sizes: [{ size: 'TBC', qty: 2 }] },
  ];

  test('ORDER_CONFIRM_QUOTE: lineTotal, unitPrice×qty fallback, TBC sizes hidden, money 2dp', () => {
    const out = T.ORDER_CONFIRM_QUOTE({ reference: 'Q9', items, subtotal: 3999.99, vat: '600', total: 4599.989, deposit: 2759.99 });
    assertClean(assert, out);
    assert.match(out, /• Polo — Navy {2}×30 {2}— R 3600\.00\n {3}S×10 {2}M×20/);
    assert.match(out, /• Hoodie {2}×2 {2}— R 399\.99(\n|$)/);
    assert.ok(!out.includes('TBC'));
    assert.match(out, /Subtotal: {2}R 3999\.99/);
    assert.match(out, /VAT \(15%\): R 600\.00/);
    assert.match(out, /Total: {4}R 4599\.99/);
    assert.match(out, /Deposit required \(60%\): R 2759\.99/);
  });

  test('ORDER_CONFIRM_QUOTE with empty items still clean', () => {
    assertClean(assert, T.ORDER_CONFIRM_QUOTE({ reference: 'Q', subtotal: 0, vat: 0, total: 0, deposit: 0 }));
  });

  test('ORDER_CONFIRM_QUOTE with seed-testing item shape {name, quantity, price, lineTotal}', () => {
    const out = T.ORDER_CONFIRM_QUOTE({
      reference: 'Q-SEED', items: [{ name: 'Executive Golf Shirt', quantity: 50, price: 289.99, lineTotal: 14499.5 }],
      subtotal: 14499.5, vat: 2174.93, total: 16674.43, deposit: 10004.66,
    });
    assertClean(assert, out);
    assert.match(out, /Executive Golf Shirt {2}×50 {2}— R 14499\.50/);
  });

  test('ORDER_CONFIRM_DIRECT: missing lineTotal → R 0.00, sizes shown, clean', () => {
    const out = T.ORDER_CONFIRM_DIRECT({
      items: [{ name: 'Cap', quantity: 1 }, { name: 'Tee', colour: 'Black', quantity: 3, lineTotal: '150', sizes: [{ size: 'L', qty: 3 }] }],
      subtotal: 150, vat: 22.5, total: 172.5, deposit: 103.5,
    });
    assertClean(assert, out);
    assert.match(out, /• Cap {2}×1 {2}— R 0\.00/);
    assert.match(out, /• Tee — Black {2}×3 {2}— R 150\.00\n {3}L×3/);
    assert.match(out, /VAT \(15%\): R 22\.50/);
  });

  test('ORDER_ASK_ITEMS / ORDER_OFFER_QUOTE / ORDER_CREATED (account clients: no deposit)', () => {
    assert.match(T.ORDER_ASK_ITEMS({ name: 'Ann Smith' }), /order, \*Ann\*\?/);
    assert.match(T.ORDER_ASK_ITEMS(), /would you like to order\? /);
    assert.match(T.ORDER_ASK_ITEMS(), /turn it into a quote for you/);
    const offer = T.ORDER_OFFER_QUOTE({ reference: 'BRQ-Q-9', items, total: 690, deposit: 414 });
    assert.match(offer, /order from your quote \*BRQ-Q-9\*[\s\S]*Total: R 690\.00[\s\S]*R 414\.00[\s\S]*1️⃣  Yes, place this order\n2️⃣  Something else/);
    assert.doesNotMatch(T.ORDER_OFFER_QUOTE({ reference: 'Q', total: 1, deposit: 1, account: true }), /Deposit/);
    const o = T.ORDER_CREATED({ reference: 'BRQ-O-00007', deposit: 1234.5 });
    assert.match(o, /R 1234\.50/);
    assert.equal(o.match(/BRQ-O-00007/g).length, 2);
    assert.doesNotMatch(T.ORDER_CREATED({ reference: 'R', deposit: 5, account: true }), /deposit/i);
    assert.doesNotMatch(T.ORDER_CONFIRM_DIRECT({ items, subtotal: 1, vat: 1, total: 1, deposit: 1, account: true }), /Deposit/);
    const rep = T.CORPORATE_REPEAT_OFFER({ reference: 'BRQ-O-00002', items, subtotal: 1, vat: 1, total: 2, deposit: 1 });
    assert.match(rep, /^🔁 \*Repeat of order BRQ-O-00002\*[\s\S]*• Polo[\s\S]*1️⃣  Yes, place order/);
  });
});

// ── Registration ──────────────────────────────────────────────────────────────
describe('registration: one message asking only for what is missing', () => {
  test('quote: name + school or company in one numbered message', () => {
    const out = T.REGISTRATION_ASK_DETAILS({ missing: ['name', 'org', 'fulfilment'], purpose: 'quote' });
    assert.equal(out,
      'To prepare your quote, please reply with:\n\n' +
      '1) your *full name*\n2) your *school or company*\n3) *collect* in store, or your *delivery address*\n\n' +
      '_e.g. "Thabo Mokoena, Dalview Primary, collect"_');
  });
  test('a single missing detail is one sentence; companies are never asked "which school"', () => {
    assert.equal(T.REGISTRATION_ASK_DETAILS({ missing: ['org'], purpose: 'quote', orgKind: 'company' }),
      'To prepare your quote, please reply with your *company or school* name. 📝');
    assert.match(T.REGISTRATION_ASK_DETAILS({ missing: ['org'], orgKind: 'school' }), /the \*school\* the uniforms are for/);
    assert.match(T.REGISTRATION_ASK_DETAILS({ missing: ['fulfilment'], purpose: 'order' }), /^To place your order, please reply with \*collect\* in store/);
    assert.match(T.REGISTRATION_ASK_DETAILS({ missing: ['address'], retry: true }), /^Thanks! I still need your \*delivery address\*/);
  });
});

describe('menus and hand-over wording', () => {
  test('one main menu: 1–7, 9 talk to a person, 0 any time; greets by first name', () => {
    const m = T.MAIN_MENU({ name: 'Thabo Mokoena' });
    assert.match(m, /^Hi \*Thabo\* 👋/);
    for (const opt of ['1️⃣  School uniforms (parents)', '2️⃣  Bulk orders (schools/companies)', '3️⃣  Get a quote',
      '4️⃣  Place an order', '5️⃣  Track my order', '6️⃣  Report a problem', '7️⃣  Store hours & location',
      '9️⃣  Talk to a person', 'Reply *0* any time for this menu.']) assert.ok(m.includes(opt), opt);
    assert.match(T.MAIN_MENU({ name: 'Thabo', welcomeBack: true }), /^Welcome back, \*Thabo\* 👋/);
    assert.ok(T.UNKNOWN_INTENT().includes('3️⃣  Get a quote'), 'unknown input shows the options');
    assert.match(T.CORPORATE_MENU(), /\*9\* Talk to a person/);
    assert.doesNotMatch(T.CORPORATE_MENU(), /6️⃣/);
  });
  test('consultant hand-over states hours and that nothing else is needed', () => {
    for (const t of [T.AWAITING_CONSULTANT(), T.CONSULTANT_ACK()]) {
      assert.match(t, /Mon–Fri 8:00–17:00, Sat 8:00–13:00/);
      assert.match(t, /You don't need to send anything else/);
    }
    assert.match(T.AWAITING_CONSULTANT({ withinHours: false }), /closed right now/);
    assert.match(T.CONSULTANT_QUEUE(), /You're in the queue/);
    assert.match(T.CONSULTANT_CANCELLED(), /cancelled your request to talk to a person[\s\S]*3️⃣  Get a quote/);
    assert.equal(T.CONSULTANT_ASSIGNED({ consultantName: 'Thabo' }), '👋 *Thabo* from Braq Uni is now helping you. Reply here any time.');
  });
  test('tickets: number and response time', () => {
    assert.match(T.TICKET_LOGGED({ ticketNo: 'AB12CD34' }), /ticket \*#AB12CD34\*[\s\S]*within \*4 business hours\*/);
    assert.match(T.TICKET_PHOTO_ADDED({ ticketNo: 'X' }), /added to your ticket \*#X\*/);
  });
});

// ── Payments ──────────────────────────────────────────────────────────────────
describe('payment templates', () => {
  test('DEPOSIT_REQUIRED', () => {
    const out = T.DEPOSIT_REQUIRED({ amount: '600.00', percentage: 60 });
    assert.match(out, /\*60% deposit\* of \*R 600\.00\*/);
  });

  test('DEPOSIT_RECEIVED: outstanding balance vs fully paid branches', () => {
    assert.match(T.DEPOSIT_RECEIVED({ amount: '600.00', balance: '400.00' }), /Remaining balance: R 400\.00/);
    for (const balance of ['0.00', '', null, undefined, 0]) {
      assert.match(T.DEPOSIT_RECEIVED({ amount: '1.00', balance }), /fully paid/, `balance=${balance}`);
    }
  });

  test('BALANCE_OUTSTANDING', () => {
    assert.match(T.BALANCE_OUTSTANDING({ amount: '12.34' }), /\*R 12\.34\*/);
  });
});

// ── Stage notifications ───────────────────────────────────────────────────────
describe('stage notification templates', () => {
  const items = [
    { name: 'Polo', colour: 'Red', quantity: 10, sizes: [{ size: 'S', qty: 4 }, { size: 'M', qty: 0 }, { size: 'TBC', qty: 6 }] },
    { description: 'Legacy jacket', quantity: 3 },
    { sizes: 'not-an-array' },
  ];

  test('STAGE_DEPOSIT_PENDING: items summary + deposit formatting', () => {
    const out = T.STAGE_DEPOSIT_PENDING({ reference: 'BRQ-O-00001', items, deposit: 600 });
    assertClean(assert, out);
    assert.match(out, /• Polo — Red {2}×10\n {3}S×4(\n|$)/, 'qty-0 and TBC sizes filtered out');
    assert.match(out, /• Legacy jacket {2}×3/);
    assert.match(out, /• Item {2}×0/);
    assert.match(out, /60% Deposit required: R 600\.00/);
  });

  test('STAGE_DEPOSIT_PENDING without items / deposit', () => {
    const out = T.STAGE_DEPOSIT_PENDING({ reference: 'R' });
    assert.ok(!out.includes('Your order:'));
    assert.match(out, /R 0\.00/);
    assertClean(assert, out);
    assertClean(assert, T.STAGE_DEPOSIT_PENDING({ reference: 'R', items: null, deposit: null }));
  });

  test('STAGE_IN_PRODUCTION optional estimated completion', () => {
    assert.match(T.STAGE_IN_PRODUCTION({ reference: 'R', items, estimatedCompletion: '5 Nov 2026' }), /Estimated completion: 5 Nov 2026/);
    const out = T.STAGE_IN_PRODUCTION({ reference: 'R' });
    assert.ok(!out.includes('Estimated') && !out.includes('In production:'));
    assertClean(assert, out);
  });

  test('STAGE_READY_COLLECTION / STAGE_READY_DELIVERY / STAGE_COMPLETED', () => {
    assert.match(T.STAGE_READY_COLLECTION({ reference: 'R', items }), /Ready for Collection[\s\S]*• Polo/);
    assertClean(assert, T.STAGE_READY_COLLECTION({ reference: 'R' }));
    assert.match(T.STAGE_READY_DELIVERY({ reference: 'R', trackingNumber: 'TRK' }), /Tracking number: TRK/);
    const d = T.STAGE_READY_DELIVERY({ reference: 'R', items });
    assert.ok(!d.includes('Tracking'));
    assertClean(assert, d);
    assert.match(T.STAGE_COMPLETED({ reference: 'R' }), /Order Complete — Ref: R/);
  });
});

// ── Misc / proof ──────────────────────────────────────────────────────────────
describe('misc & proof templates', () => {
  test('SUPPLIER_DELAY / CONSULTANT_ASSIGNED', () => {
    assert.match(T.SUPPLIER_DELAY({ reference: 'R7' }), /Order update — R7/);
    assert.match(T.CONSULTANT_ASSIGNED({ consultantName: UNI }), /\*Zoë/);
  });

  test('PROOF_SENT with and without notes', () => {
    const a = T.PROOF_SENT({ reference: 'R', proofUrl: 'https://x/y.png', notes: 'Logo left chest' });
    assert.match(a, /Logo left chest\n\nPlease review/);
    assert.match(a, /https:\/\/x\/y\.png/);
    const b = T.PROOF_SENT({ reference: 'R', proofUrl: 'https://x', notes: null });
    assert.match(b, /Ref: R\*\n\nPlease review/);
    assertClean(assert, b);
  });

  test('PROOF_APPROVED / REVISION_REQUESTED / REVISION_ASK', () => {
    assert.match(T.PROOF_APPROVED({ reference: 'R' }), /Proof Approved — Ref: R/);
    assert.match(T.PROOF_REVISION_REQUESTED({ reference: 'R' }), /Revision Noted — Ref: R/);
    assert.match(T.PROOF_REVISION_ASK({ reference: 'R' }), /order \*R\*/);
  });

  test('very long + unicode references are embedded verbatim', () => {
    const ref = UNI + LONG;
    for (const k of ['PROOF_APPROVED', 'STAGE_COMPLETED', 'SUPPLIER_DELAY', 'QUOTE_ACCEPTED']) {
      assert.ok(T[k]({ reference: ref }).includes(ref), k);
    }
  });
});
