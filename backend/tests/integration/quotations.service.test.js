// quotations service against a real Postgres, with the fake Gemini / WhatsApp
// APIs: free-text drafts, approval (PDF queued to the client — delivered by
// draining the job queue through quotation.pdf.send), auto-approval, listing,
// expiry and status transitions.
import { describe, test, before, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb } from '../helpers/db.js';

const t = await setupTestDb();
const svc = await t.load('modules/quotations/service.js');

let products;
beforeEach(async () => {
  await t.reset();
  products = {
    polo: await t.one(`INSERT INTO products (category, name, price) VALUES ('corporate_wear', 'Polo', 120.00) RETURNING *`),
    hoodie: await t.one(`INSERT INTO products (category, name, price) VALUES ('outdoor_wear', 'Hoodie', 250) RETURNING *`),
  };
});
afterEach(() => mock.timers.reset());
after(() => t.stop());

/** Fake Gemini: parse → `parse`, pricing suggestion → `suggest` (objects or Error to fail). */
function aiReplies({ parse = { items: [], unmatchedText: [] }, suggest = { items: [] } }) {
  t.ai.set((body) => {
    const isPricing = JSON.stringify(body).includes('pricing specialist');
    const r = isPricing ? suggest : parse;
    return r instanceof Error ? 'not json' : r;
  });
}
const pricingCalls = () => t.ai.calls.filter((c) => JSON.stringify(c.body).includes('pricing specialist'));
const quoteRow = (id) => t.one('SELECT * FROM quotations WHERE id = $1', [id]);

// ── createFromFreeText ───────────────────────────────────────────────────────
describe('createFromFreeText', () => {
  test('matched items → priced lines, default TBC size, totals, SLA +4h, daily SA reference', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T10:00:00Z').getTime() });
    const client = await t.factory.client();
    aiReplies({ parse: { items: [
      { productId: products.polo.id, quantity: 10, colour: 'Navy', sizes: [{ size: 'M', qty: 10 }] },
      { productId: products.hoodie.id, quantity: 2 },
    ], unmatchedText: [] } });
    await t.query(`INSERT INTO sequence_counters (key, date_key, value) VALUES ('quotation', '20261020', 2)`);
    const { quotation, unmatchedText } = await svc.createFromFreeText(client.id, '10 polos navy, 2 hoodies');
    assert.deepEqual(unmatchedText, []);
    assert.equal(pricingCalls().length, 0, 'no AI pricing when everything matched');
    assert.equal(quotation.reference, 'BRQ-Q-20261020-0003');
    const row = await quoteRow(quotation.id);
    assert.equal(row.status, 'draft');
    assert.equal(row.client_id, client.id);
    assert.equal(row.line_items.length, 2);
    assert.deepEqual(row.line_items[0], {
      productId: products.polo.id, name: 'Polo', category: 'corporate_wear', colour: 'Navy', sizes: [{ size: 'M', qty: 10 }],
      quantity: 10, unitPrice: 120, brandingSurcharge: 0, effectiveUnitPrice: 120,
      branding: { type: 'none', position: '', detail: '' }, lineTotal: 1200, priceConfirmed: true,
    });
    assert.deepEqual(row.line_items[1].sizes, [{ size: 'TBC', qty: 2 }]);
    assert.equal(row.line_items[1].colour, '');
    assert.deepEqual([Number(row.subtotal), Number(row.vat), Number(row.total), row.currency], [1700, 255, 1955, 'ZAR']);
    assert.equal(row.sla_remind_at.toISOString(), '2026-10-20T14:00:00.000Z');
    assert.equal(row.notes, '10 polos navy, 2 hoodies');
  });

  test('FIN-4: fractional / huge quantities and sizes that do not add up are never auto-priced', async () => {
    const client = await t.factory.client();
    aiReplies({ parse: { items: [
      { productId: products.polo.id, quantity: 2.5, description: '2.5 polos' },
      { productId: products.polo.id, quantity: 900000, description: 'a lot of polos' },
      { productId: products.hoodie.id, quantity: 10, sizes: [{ size: 'M', qty: 3 }, { size: 'L', qty: 3 }], description: '10 hoodies M×3 L×3' },
      { productId: products.hoodie.id, quantity: 6, sizes: [{ size: 'TBC', qty: 6 }] },
    ], unmatchedText: [] } });
    const { quotation, unmatchedText } = await svc.createFromFreeText(client.id, 'mixed request');
    assert.deepEqual(unmatchedText, ['2.5 polos', 'a lot of polos', '10 hoodies M×3 L×3']);
    const priced = (await quoteRow(quotation.id)).line_items.filter((i) => i.priceConfirmed);
    assert.deepEqual(priced.map((i) => i.quantity), [6], 'only the plausible line is auto-priced');
  });

  test('unknown product / zero / negative / missing quantity → unmatched, then AI-suggested (unconfirmed) lines', async () => {
    const client = await t.factory.client();
    aiReplies({
      parse: { items: [
        { productId: crypto.randomUUID(), quantity: 5, description: '5 swim caps' },
        { productId: products.polo.id, quantity: 0 },
        { productId: products.polo.id, quantity: -3, description: 'neg polos' },
        { productId: crypto.randomUUID() },
      ], unmatchedText: ['safety boots x4'] },
      suggest: { items: [{ description: 'Swim cap', quantity: 5, unitPrice: 35.5, confidence: 'medium', notes: 'similar to caps' }] },
    });
    const { quotation, unmatchedText } = await svc.createFromFreeText(client.id, 'stuff');
    assert.deepEqual(unmatchedText, ['safety boots x4', '5 swim caps', '0 × unrecognised item', 'neg polos', '? × unrecognised item']);
    assert.equal(pricingCalls().length, 1);
    const prompt = JSON.stringify(pricingCalls()[0].body);
    assert.ok(prompt.includes('stuff') && prompt.includes('safety boots x4'), 'pricing prompt carries the request and unmatched items');
    const row = await quoteRow(quotation.id);
    assert.equal(row.line_items.length, 1);
    const [li] = row.line_items;
    assert.deepEqual([li.productId, li.category, li.unitPrice, li.lineTotal, li.priceConfirmed], [null, 'custom', 35.5, 177.5, false]);
    assert.equal(li.aiNote, 'AI: R35.5/unit (medium) — similar to caps');
    assert.equal(Number(row.subtotal), 177.5);
  });

  test('AI pricing unavailable → manual-pricing placeholder lines (R0, low confidence)', async () => {
    const client = await t.factory.client();
    aiReplies({ parse: { items: [], unmatchedText: ['mystery'] }, suggest: new Error('quota') });
    const { quotation, unmatchedText } = await svc.createFromFreeText(client.id, 'x');
    assert.deepEqual(unmatchedText, ['mystery']);
    const row = await quoteRow(quotation.id);
    assert.equal(row.line_items.length, 1);
    assert.equal(row.line_items[0].unitPrice, 0);
    assert.match(row.line_items[0].aiNote, /low.*Manual pricing required/);
    assert.deepEqual([Number(row.subtotal), Number(row.vat), Number(row.total)], [0, 0, 0]);
  });

  test('parser failure → the whole text is unmatched and priced manually', async () => {
    const client = await t.factory.client();
    aiReplies({ parse: new Error('bad json'), suggest: { items: [] } });
    const { unmatchedText } = await svc.createFromFreeText(client.id, 'hello there');
    assert.deepEqual(unmatchedText, ['hello there']);
  });

  test('parser returns no items and nothing unmatched → empty draft, no AI pricing', async () => {
    const client = await t.factory.client();
    aiReplies({ parse: { items: [] } });
    const r = await svc.createFromFreeText(client.id, '');
    assert.deepEqual(r.unmatchedText, []);
    assert.equal(pricingCalls().length, 0);
    assert.deepEqual((await quoteRow(r.quotation.id)).line_items, []);
  });

  test('reference date uses the South African date (01:00 SAST on 21 Oct → 20261021)', async () => {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T01:00:00+02:00').getTime() });
    const client = await t.factory.client();
    aiReplies({});
    const { quotation } = await svc.createFromFreeText(client.id, 'x');
    assert.equal(quotation.reference, 'BRQ-Q-20261021-0001');
  });

  test('references count up per day; a failed insert does not leave a draft', async () => {
    const client = await t.factory.client();
    aiReplies({});
    const a = await svc.createFromFreeText(client.id, 'a');
    const b = await svc.createFromFreeText(client.id, 'b');
    assert.equal(Number(b.quotation.reference.slice(-4)), Number(a.quotation.reference.slice(-4)) + 1);
    await assert.rejects(svc.createFromFreeText(crypto.randomUUID(), 'c'), (e) => e.code === '23503');
    assert.equal((await t.one('SELECT COUNT(*)::int AS n FROM quotations')).n, 2);
  });
});

// ── approve / auto-approve ───────────────────────────────────────────────────
async function draft(o = {}) {
  const client = await t.factory.client({ name: 'Ann', organisation: 'ACME', whatsapp_number: o.wa ?? '27820001111' });
  return t.factory.quotation({ client_id: client.id, status: o.status ?? 'draft', reference: 'BRQ-Q-20261020-0001' });
}

describe('approveQuotation', () => {
  test('404 when missing, 400 when not draft', async () => {
    const staff = await t.factory.staff();
    await assert.rejects(svc.approveQuotation(crypto.randomUUID(), [], staff.id), (e) => e.status === 404);
    const sent = await draft({ status: 'sent' });
    await assert.rejects(svc.approveQuotation(sent.id, [], staff.id), (e) => e.status === 400);
  });

  test('confirms all items, recomputes totals, sends the PDF to the client', async () => {
    const staff = await t.factory.staff();
    const q = await draft();
    const items = [{ name: 'Polo', lineTotal: 1000, priceConfirmed: false }, { name: 'Cap', lineTotal: '200' }, { name: 'Free' }];
    const { quotation, whatsappSent } = await svc.approveQuotation(q.id, items, staff.id);
    assert.equal(whatsappSent, true);
    const row = await quoteRow(q.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.line_items.every((i) => i.priceConfirmed === true));
    assert.deepEqual([Number(row.subtotal), Number(row.vat), Number(row.total), row.approved_by], [1200, 180, 1380, staff.id]);
    assert.ok(row.approved_at && row.valid_until);
    assert.equal(Number(quotation.total), 1380);
    assert.equal(t.wa.uploads.length, 0, 'nothing sent before the worker runs');
    await t.drainJobs();
    assert.equal(t.wa.uploads.length, 1);
    assert.ok(t.wa.uploads[0].includes('BRQ-Q-20261020-0001.pdf'), 'uploaded file is named after the reference');
    assert.ok(t.wa.uploads[0].includes('%PDF-'), 'a PDF was uploaded');
    const [doc] = t.wa.documents('27820001111');
    assert.equal(doc.id, 'MEDIA_1');
    assert.equal(doc.filename, 'BRQ-Q-20261020-0001.pdf');
    assert.match(doc.caption, /Total: R 1380\.00 \(incl\. VAT\)/);
    assert.match(doc.caption, /Valid until \d{1,2} \w{3} \d{4}\.$/, 'the expiry date itself, not "valid for 30 days"');
  });

  test('VAT/total rounded half-up to the cent before persisting; caption matches the stored total', async () => {
    const q = await draft();
    await svc.approveQuotation(q.id, [{ lineTotal: 150.5 }], null);
    const row = await quoteRow(q.id);
    assert.deepEqual([Number(row.vat), Number(row.total)], [22.58, 173.08]);
    await t.drainJobs();
    assert.match(t.wa.documents()[0].caption, /R 173\.08/);
  });

  test('client lineTotal is ignored: line = quantity × (unitPrice + surcharge); valid_until = today + 30 (SA)', async () => {
    const q = await draft();
    await svc.approveQuotation(q.id, [{ name: 'Jacket', quantity: 10, unitPrice: 100, brandingSurcharge: 15, lineTotal: 1 }], null);
    const row = await quoteRow(q.id);
    assert.equal(row.line_items[0].effectiveUnitPrice, 115);
    assert.equal(row.line_items[0].lineTotal, 1150);
    assert.deepEqual([Number(row.subtotal), Number(row.vat), Number(row.total)], [1150, 172.5, 1322.5]);
    const { expected } = await t.one(`SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date + 30)::text AS expected`);
    const { got } = await t.one(`SELECT valid_until::text AS got FROM quotations WHERE id = $1`, [q.id]);
    assert.equal(got, expected);
  });

  test('concurrent approvals: one wins, the other gets 409; one PDF sent', async () => {
    const q = await draft();
    const results = await Promise.allSettled([
      svc.approveQuotation(q.id, [{ lineTotal: 10 }], null),
      svc.approveQuotation(q.id, [{ lineTotal: 10 }], null),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = results.find((r) => r.status === 'rejected');
    assert.ok([400, 409].includes(lost.reason.status), `got ${lost.reason.status}`);
    await t.drainJobs();
    assert.equal(t.wa.documents().length, 1);
  });

  test('no client WhatsApp → nothing sent, whatsappSent=false', async () => {
    const q = await draft({ wa: '' });
    const r = await svc.approveQuotation(q.id, [{ lineTotal: 1 }], null);
    assert.equal(r.whatsappSent, false);
    assert.equal(t.wa.uploads.length, 0);
  });

  test('upload failure → quotation still approved; the PDF job is retried, then delivered once', async () => {
    const q = await draft();
    t.wa.failNextUpload(1);
    const r = await svc.approveQuotation(q.id, [{ lineTotal: 1 }], null);
    assert.equal(r.whatsappSent, true, 'queued');
    assert.equal((await quoteRow(q.id)).status, 'sent');
    // The retry (backoff 2×10 ms in tests) may already be due within the same drain.
    const first = await t.drainJobs();
    assert.equal(first.retry, 1);
    assert.equal(first.dead, 0);
    await t.query(`UPDATE jobs SET run_at = now() WHERE status = 'pending'`);
    await t.drainJobs();
    assert.deepEqual((await t.jobs('quotation.pdf.send')).map((j) => [j.status, j.attempts]), [['done', 2]]);
    assert.equal(t.wa.documents().length, 1);
  });

  test('FIN-5: a PDF job for a quote revised back to draft before it ran sends nothing', async () => {
    const q = await draft();
    await svc.approveQuotation(q.id, [{ lineTotal: 1 }], null);
    await t.query(`UPDATE quotations SET status = 'draft' WHERE id = $1`, [q.id]); // revised while the job waited
    await t.drainJobs();
    assert.equal(t.wa.documents().length, 0, 'no draft prices sent with "Reply accept"');
    assert.deepEqual((await t.jobs('quotation.pdf.send')).map((j) => j.status), ['done']);
  });

  test('approving records the PDF message in the inbox and hands an awaiting-consultant chat back to the bot', async () => {
    const q = await draft();
    const convo = await t.factory.conversation({ client_id: q.client_id, state: 'awaiting_consultant' });
    await svc.approveQuotation(q.id, [{ lineTotal: 10 }], null);
    assert.equal((await t.one('SELECT state FROM conversations WHERE id = $1', [convo.id])).state, 'main_menu');
    await t.drainJobs();
    const [msg] = (await t.query('SELECT body, direction, job_id FROM messages WHERE conversation_id = $1', [convo.id])).rows;
    assert.equal(msg.direction, 'outbound');
    assert.match(msg.body, /^\[document: BRQ-Q-20261020-0001\.pdf\]/);
    assert.ok(msg.job_id);
    assert.match(t.wa.documents()[0].caption, /Reply \*accept\* to go ahead/);
  });

  test('a consultant actively chatting keeps the conversation (consultant_active is not handed back)', async () => {
    const q = await draft();
    const convo = await t.factory.conversation({ client_id: q.client_id, state: 'consultant_active' });
    await svc.approveQuotation(q.id, [{ lineTotal: 10 }], null);
    assert.equal((await t.one('SELECT state FROM conversations WHERE id = $1', [convo.id])).state, 'consultant_active');
  });
});

describe('autoApproveQuotation', () => {
  test('non-draft → null, nothing changed', async () => {
    const q = await draft({ status: 'accepted' });
    assert.equal(await svc.autoApproveQuotation(q.id, []), null);
    assert.equal((await quoteRow(q.id)).status, 'accepted');
  });

  test('draft → sent + auto_quoted, PDF sent with the accept prompt', async () => {
    const q = await draft();
    const r = await svc.autoApproveQuotation(q.id, [{ lineTotal: 100 }]);
    assert.equal(r.id, q.id);
    const row = await quoteRow(q.id);
    assert.deepEqual([row.status, row.auto_quoted, Number(row.subtotal), Number(row.vat), Number(row.total)], ['sent', true, 100, 15, 115]);
    assert.ok(row.valid_until);
    await t.drainJobs();
    assert.match(t.wa.documents()[0].caption, /Reply \*accept\*/);
  });

  test('send failure swallowed; no WhatsApp → no send', async () => {
    const q = await draft();
    t.wa.failNextUpload(1);
    assert.equal((await svc.autoApproveQuotation(q.id, [])).id, q.id);
    await t.reset();
    const quiet = await draft({ wa: '' });
    await svc.autoApproveQuotation(quiet.id, []);
    assert.equal(t.wa.documents().length, 0);
  });
});

// ── listing / lookups / transitions ──────────────────────────────────────────
describe('list/get/update helpers', () => {
  test('listQuotations: all, or by status; joins client, staff and order', async () => {
    const staff = await t.factory.staff({ name: 'Sam' });
    const client = await t.factory.client({ name: 'Ann' });
    const d = await t.factory.quotation({ client_id: client.id, status: 'draft', assigned_staff_id: staff.id });
    const a = await t.factory.quotation({ client_id: client.id, status: 'accepted' });
    const order = await t.factory.order({ client_id: client.id, quotation_id: a.id });
    const all = await svc.listQuotations();
    assert.equal(all.items.length, 2);
    assert.deepEqual([all.total, all.page], [2, 1]);
    const drafts = (await svc.listQuotations({ status: 'draft' })).items;
    assert.equal(drafts[0].lifecycle_state, 'PRICING');
    assert.deepEqual(drafts.map((q) => q.id), [d.id]);
    assert.equal(drafts[0].client_name, 'Ann');
    assert.equal(drafts[0].assigned_name, 'Sam');
    const [acc] = (await svc.listQuotations({ status: 'accepted' })).items;
    assert.equal(acc.order_id, order.id);
    assert.equal(acc.lifecycle_state, 'AWAITING_DEPOSIT');
    await assert.rejects(svc.listQuotations({ status: 'bogus' }), (e) => e.status === 400);
  });

  test('a lapsed sent quotation is reported (and filtered) as expired', async () => {
    const lapsed = await t.factory.quotation({ status: 'sent', valid_until: '2020-01-01' });
    const live = await t.factory.quotation({ status: 'sent', valid_until: '2999-01-01' });
    assert.equal((await svc.getQuotationById(lapsed.id)).status, 'expired');
    assert.equal((await svc.getQuotationById(live.id)).status, 'sent');
    assert.deepEqual((await svc.listQuotations({ status: 'sent' })).items.map((q) => q.id), [live.id]);
    assert.deepEqual((await svc.listQuotations({ status: 'expired' })).items.map((q) => q.id), [lapsed.id]);
    const lapsedRow = (await svc.listQuotations()).items.find((q) => q.id === lapsed.id);
    assert.equal(lapsedRow.status, 'expired');
    assert.equal(lapsedRow.lifecycle_state, 'EXPIRED');
  });

  test('getQuotationById: 404 for an unknown id', async () => {
    await assert.rejects(svc.getQuotationById(crypto.randomUUID()), (e) => e.status === 404);
  });

  test('updateQuotationStatus: validation / 404 / allowed transitions', async () => {
    await assert.rejects(svc.updateQuotationStatus(crypto.randomUUID(), 'paid'), (e) => e.status === 400);
    await assert.rejects(svc.updateQuotationStatus(crypto.randomUUID(), 'sent'), (e) => e.status === 404);
    const q = await t.factory.quotation({ status: 'draft' });
    await svc.updateQuotationStatus(q.id, 'sent');
    assert.ok((await quoteRow(q.id)).valid_until, 'sending sets valid_until');
    await svc.updateQuotationStatus(q.id, 'accepted');
    await svc.updateQuotationStatus(q.id, 'rejected');
    await svc.updateQuotationStatus(q.id, 'draft');
    assert.equal((await quoteRow(q.id)).status, 'draft');
  });

  test('updateQuotationStatus refuses disallowed transitions with 409 and a reason', async () => {
    const withOrder = await t.factory.quotation({ status: 'accepted' });
    await t.factory.order({ client_id: withOrder.client_id, quotation_id: withOrder.id });
    await assert.rejects(svc.updateQuotationStatus(withOrder.id, 'draft'), (e) => e.status === 409 && /order already exists/.test(e.message));
    const lapsed = await t.factory.quotation({ status: 'sent', valid_until: '2020-01-01' });
    await assert.rejects(svc.updateQuotationStatus(lapsed.id, 'accepted'), (e) => e.status === 409 && /expired/.test(e.message));
    const draftQ = await t.factory.quotation({ status: 'draft' });
    await assert.rejects(svc.updateQuotationStatus(draftQ.id, 'accepted'), (e) => e.status === 409 && /from 'draft' to 'accepted'/.test(e.message));
  });

  test('acceptQuotationByClient: latest valid sent quotation, else null', async () => {
    const client = await t.factory.client();
    assert.equal(await svc.acceptQuotationByClient(client.id), null);
    await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2020-01-01' });
    assert.equal(await svc.acceptQuotationByClient(client.id), null, 'expired quotes cannot be accepted');
    const q = await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2999-01-01' });
    const r = await svc.acceptQuotationByClient(client.id);
    assert.equal(r.id, q.id);
    assert.equal((await quoteRow(q.id)).status, 'accepted');
  });

  test('getQuotationByReference: scoped to the client, null when absent', async () => {
    const client = await t.factory.client();
    const other = await t.factory.client();
    const q = await t.factory.quotation({ client_id: client.id, reference: 'BRQ-Q-REF-1' });
    assert.equal(await svc.getQuotationByReference('BRQ-Q-REF-1', other.id), null);
    assert.equal((await svc.getQuotationByReference('BRQ-Q-REF-1', client.id)).id, q.id);
  });

  test('expireStaleQuotations persists expired only on lapsed sent quotations', async () => {
    const lapsed = await t.factory.quotation({ status: 'sent', valid_until: '2020-01-01' });
    const draftOld = await t.factory.quotation({ status: 'draft', valid_until: '2020-01-01' });
    assert.equal(await svc.expireStaleQuotations(), 1);
    assert.equal((await quoteRow(lapsed.id)).status, 'expired');
    assert.equal((await quoteRow(draftOld.id)).status, 'draft');
  });
});

describe('pricing helpers', () => {
  test('priceLineItem: quantity × (unit + surcharge); legacy lines keep a rounded lineTotal', () => {
    assert.deepEqual(svc.priceLineItem({ quantity: 3, unitPrice: '10.10', brandingSurcharge: 1 }).lineTotal, 33.3);
    assert.equal(svc.priceLineItem({ quantity: 2, price: 5 }).effectiveUnitPrice, 5);
    assert.equal(svc.priceLineItem({ quantity: 2, effectiveUnitPrice: 7.5 }).lineTotal, 15);
    assert.equal(svc.priceLineItem({ lineTotal: '12.345' }).lineTotal, 12.35);
  });

  test('calcTotals: VAT 15% half-up on the cent subtotal', () => {
    assert.deepEqual(svc.calcTotals([{ lineTotal: 150.5 }]), { subtotal: 150.5, vatAmount: 22.58, total: 173.08 });
    assert.deepEqual(svc.calcTotals([]), { subtotal: 0, vatAmount: 0, total: 0 });
  });
});

// ── staff-created quotes, resend, events, client accept by reference ─────────
describe('createQuotation / createAcceptedQuotation / resend / events', () => {
  test('createQuotation: draft assigned to the creator, priced items (unconfirmed), SLA set, conversation checked', async () => {
    const staff = await t.factory.staff();
    const client = await t.factory.client();
    const convo = await t.factory.conversation({ client_id: client.id });
    const q = await svc.createQuotation({ clientId: client.id, conversationId: convo.id, lineItems: [{ name: 'Cap', quantity: 4, unitPrice: 25 }], notes: 'from chat' }, staff);
    assert.deepEqual([q.status, q.assigned_staff_id, q.conversation_id, q.notes], ['draft', staff.id, convo.id, 'from chat']);
    assert.ok(q.claimed_at && q.sla_remind_at);
    assert.deepEqual([Number(q.subtotal), Number(q.total), q.line_items[0].priceConfirmed], [100, 115, false]);
    assert.match(q.reference, /^BRQ-Q-\d{8}-\d{4}$/);
    const other = await t.factory.client();
    await assert.rejects(svc.createQuotation({ clientId: other.id, conversationId: convo.id }, staff), (e) => e.status === 400);
    await assert.rejects(svc.createQuotation({ clientId: '00000000-0000-4000-8000-000000000000' }, staff), (e) => e.status === 400);
  });

  test('status changes go through the machine and are recorded as job events (with the actor)', async () => {
    const staff = await t.factory.staff();
    const q = await t.factory.quotation({ status: 'sent', valid_until: '2999-01-01' });
    await svc.updateQuotationStatus(q.id, 'rejected', { actorId: staff.id });
    await svc.updateQuotationStatus(q.id, 'draft', { actorId: staff.id });
    const events = (await t.query('SELECT type, actor_id FROM job_events WHERE quotation_id = $1 ORDER BY id', [q.id])).rows;
    assert.deepEqual(events.map((e) => [e.type, e.actor_id]), [['quotation.declined', staff.id], ['quotation.revised', staff.id]]);
    await assert.rejects(svc.updateQuotationStatus(q.id, 'accepted'), (e) => e.status === 409 && e.extra.code === 'INVALID_TRANSITION');
  });

  test('resendQuotation: queues the PDF again (sent / accepted only)', async () => {
    const client = await t.factory.client({ whatsapp_number: '27820009999' });
    const q = await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2999-01-01', reference: 'BRQ-Q-20261021-0042' });
    await svc.resendQuotation(q.id, null);
    await t.drainJobs();
    const [doc] = t.wa.documents('27820009999');
    assert.equal(doc.filename, 'BRQ-Q-20261021-0042.pdf');
    const draft = await t.factory.quotation({ client_id: client.id, status: 'draft' });
    await assert.rejects(svc.resendQuotation(draft.id, null), (e) => e.status === 409 && e.extra.code === 'QUOTE_NOT_SENT');
    const lapsed = await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2020-01-01' });
    await assert.rejects(svc.resendQuotation(lapsed.id, null), (e) => e.status === 409);
    await assert.rejects(svc.resendQuotation('00000000-0000-4000-8000-000000000000', null), (e) => e.status === 404);
  });

  test('acceptQuotationByClient({ reference }): that quote only; expired / other statuses → null', async () => {
    const client = await t.factory.client();
    const a = await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2999-01-01', reference: 'BRQ-Q-A' });
    const b = await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2999-01-01', reference: 'BRQ-Q-B' });
    await t.factory.quotation({ client_id: client.id, status: 'sent', valid_until: '2020-01-01', reference: 'BRQ-Q-OLD' });
    assert.equal((await svc.acceptQuotationByClient(client.id, { reference: 'BRQ-Q-A' })).id, a.id);
    assert.equal((await quoteRow(b.id)).status, 'sent');
    assert.equal(await svc.acceptQuotationByClient(client.id, { reference: 'BRQ-Q-A' }), null, 'already accepted');
    assert.equal(await svc.acceptQuotationByClient(client.id, { reference: 'BRQ-Q-OLD' }), null, 'expired');
    const [ev] = (await t.query('SELECT data FROM job_events WHERE quotation_id = $1', [a.id])).rows;
    assert.equal(ev.data.source, 'client');
  });
});
