// Quotation PDF rendering + line pricing (pure, no database).
import './_setup.js';
import { describe, test, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src, BAD_TOKENS } from './_setup.js';

let svc, PDFDocument;
before(async () => {
  svc = await import(src('modules/quotations/pdf.js'));
  PDFDocument = (await import('pdfkit')).default;
});

// ── renderQuotationPdf ────────────────────────────────────────────────────────
describe('renderQuotationPdf', () => {
  let texts, addPages;
  beforeEach(() => {
    texts = []; addPages = 0;
    const origText = PDFDocument.prototype.text;
    const origAdd = PDFDocument.prototype.addPage;
    mock.method(PDFDocument.prototype, 'text', function (t, ...rest) { texts.push(String(t)); return origText.call(this, t, ...rest); });
    mock.method(PDFDocument.prototype, 'addPage', function (...a) { addPages++; return origAdd.apply(this, a); });
  });
  afterEach(() => mock.restoreAll());

  const finish = (doc) => new Promise((res) => { const c = []; doc.on('data', (d) => c.push(d)); doc.on('end', () => res(Buffer.concat(c))); doc.end(); });
  const clean = () => {
    const all = texts.join('\n');
    for (const bad of [...BAD_TOKENS, 'Invalid Date']) assert.ok(!all.includes(bad), `PDF text contains "${bad}"`);
    return all;
  };

  test('new-format items: sizes/branding sub-lines, totals, 60% deposit, client block', async () => {
    const q = {
      reference: 'BRQ-Q-1', created_at: '2026-10-20T08:00:00Z', valid_until: '2026-11-19',
      subtotal: '1000', vat: '150', total: '1150',
      line_items: [
        { name: 'Polo', colour: 'Navy', quantity: 10, effectiveUnitPrice: 100, lineTotal: 1000,
          sizes: [{ size: 'S', qty: 4 }, { size: 'M', qty: 6 }, { size: 'L', qty: 0 }],
          branding: { type: 'embroidery_logo', position: 'left_chest', detail: 'Gold thread' } },
        { name: 'Cap', quantity: 2, effectiveUnitPrice: 0, sizes: [], branding: { type: 'none' } },
      ],
    };
    const buf = await finish(svc.renderQuotationPdf(q, { name: 'Ann', organisation: 'ACME', whatsapp_number: '2782', physical_address: '1 Main' }));
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const all = clean();
    for (const s of ['Ref: BRQ-Q-1', 'Ann', 'ACME', 'WhatsApp: 2782', '1 Main', 'Polo — Navy', 'Sizes: S×4   M×6',
      'Branding: embroidery logo · left chest · Gold thread', 'R 100.00', 'R 1000.00', 'R 150.00', 'R 1150.00', 'R 690.00', 'R 0.00']) {
      assert.ok(all.includes(s), `missing "${s}"`);
    }
    assert.ok(!all.includes('L×0'));
    assert.match(all, /Valid Until: \d{2} Nov 2026/);
  });

  test('legacy-format items (price, description, string sizes/branding) and fallbacks', async () => {
    const q = {
      reference: 'R', created_at: new Date(), subtotal: 0, vat: 0, total: 0, client_name: 'From Row',
      line_items: [
        { description: 'Old jacket', price: '55.5', quantity: 2, sizes: 'S, M', branding: 'Screen print' },
        { quantity: undefined, sizes: '', branding: '' },
      ],
    };
    await finish(svc.renderQuotationPdf(q, { client_wa: '2799' }));
    const all = texts.join('\n');
    for (const s of ['From Row', 'WhatsApp: 2799', 'Old jacket', 'R 55.50', 'R 111.00', 'Sizes: S, M', 'Branding: Screen print', '30 days from date', '—']) {
      assert.ok(all.includes(s), `missing "${s}"`);
    }
  });

  test('no clientInfo / no line items → "Valued Client", still a valid PDF', async () => {
    const buf = await finish(svc.renderQuotationPdf({ reference: 'R', created_at: Date.now(), subtotal: 0, vat: 0, total: 0, line_items: 'not-array' }));
    assert.ok(texts.includes('Valued Client'));
    assert.ok(buf.length > 500);
    clean();
  });

  test('many items trigger page breaks', async () => {
    const line_items = Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, effectiveUnitPrice: 1, lineTotal: 1 }));
    await finish(svc.renderQuotationPdf({ reference: 'R', created_at: Date.now(), subtotal: 40, vat: 6, total: 46, line_items }));
    assert.ok(addPages >= 1, 'expected at least one addPage');
    assert.ok(texts.includes('Item 39'));
  });

  test('footer must not claim prices are VAT-inclusive when VAT is added on top', async () => {
    await finish(svc.renderQuotationPdf({ reference: 'R', created_at: Date.now(), subtotal: 100, vat: 15, total: 115, line_items: [{ name: 'A', quantity: 1, effectiveUnitPrice: 100, lineTotal: 100 }] }));
    assert.ok(!texts.some((t) => /inclusive of VAT/i.test(t)), 'unit/line prices are ex-VAT (subtotal + 15% VAT = total)');
  });
});

// Owner decision 2: payment details are arranged by the consultant, never printed.
test('the quote PDF carries no (placeholder) bank account', async () => {
  const { mock: m } = await import('node:test');
  const texts = [];
  const orig = PDFDocument.prototype.text;
  m.method(PDFDocument.prototype, 'text', function (t, ...rest) { texts.push(String(t)); return orig.call(this, t, ...rest); });
  try {
    const doc = svc.renderQuotationPdf({ reference: 'Q', total: '115', subtotal: '100', vat: '15', line_items: [] }, {});
    doc.end();
    const all = texts.join('\n');
    assert.doesNotMatch(all, /123 456 789|Branch Code|Account No|BANKING DETAILS/);
    assert.match(all, /Payment details will be provided by your consultant\./);
  } finally {
    m.restoreAll();
  }
});
