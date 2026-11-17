// Size run sheet PDF rendering (modules/orders/sizeRunSheet.pdf.js) — pure.
// The HTTP route (headers, 400/404/500) is covered in tests/integration/http.test.js.
import './_setup.js';
import { describe, test, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { src, BAD_TOKENS } from './_setup.js';

let renderSizeRunSheet, PDFDocument;
before(async () => {
  ({ renderSizeRunSheet } = await import(src('modules/orders/sizeRunSheet.pdf.js')));
  PDFDocument = (await import('pdfkit')).default;
});

let texts, pages;
beforeEach(() => {
  texts = []; pages = 0;
  const t = PDFDocument.prototype.text;
  const a = PDFDocument.prototype.addPage;
  mock.method(PDFDocument.prototype, 'text', function (s, ...r) { texts.push(String(s)); return t.call(this, s, ...r); });
  mock.method(PDFDocument.prototype, 'addPage', function (...r) { pages++; return a.apply(this, r); });
});
afterEach(() => mock.restoreAll());

const clean = () => { for (const bad of BAD_TOKENS) assert.ok(!texts.join('\n').includes(bad), bad); };

describe('renderSizeRunSheet', () => {
  test('header shows order ref + client name; sizes table and totals; valid PDF', async () => {
    const pdf = await renderSizeRunSheet({
      order: { reference: 'BRQ-O-00042', client_name: 'Dalpark Primary', stage: 'in_production' },
      items: [{ name: 'Polo', colour: 'Navy', sizes: [{ size: 'S', qty: 4 }, { size: 'M', qty: '6' }] }],
    });
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    for (const s of ['Order: BRQ-O-00042', 'Client: Dalpark Primary', 'Dalpark Primary', 'IN PRODUCTION', 'Polo', 'Total Qty: 10', 'Navy', 'S', 'M', '4', '6']) {
      assert.ok(texts.includes(s), `missing "${s}"`);
    }
    clean();
  });

  for (const key of ['brandingNotes', 'notes']) {
    test(`item with ${key} renders (oblique font, no .italic())`, async () => {
      await renderSizeRunSheet({ order: { reference: 'R', client_name: 'C', stage: 'ready' }, items: [{ name: 'Polo', quantity: 5, [key]: 'Crest left chest' }] });
      assert.ok(texts.includes('Notes: Crest left chest'));
    });
  }

  test('missing client name / stage → "—" placeholders, never "undefined"', async () => {
    await renderSizeRunSheet({ order: { reference: 'R' }, items: [] });
    assert.ok(texts.includes('Client: —'));
    assert.ok(texts.includes('No line items found for this order.'));
    clean();
  });

  test('item without sizes uses quantity; unnamed item', async () => {
    await renderSizeRunSheet({ order: { reference: 'R', client_name: 'C', stage: 'ready' }, items: [{ quantity: 12 }, { sizes: [] }] });
    assert.ok(texts.includes('Unnamed Item'));
    assert.ok(texts.includes('Total Qty: 12'));
    assert.ok(texts.includes('Quantity: 12'));
    assert.ok(texts.includes('Total Qty: 0'));
  });

  test('sizes with missing size/qty render "?" / 0', async () => {
    await renderSizeRunSheet({ order: { reference: 'R', client_name: 'C', stage: 'ready' }, items: [{ name: 'X', sizes: [{}, { size: 'L', qty: 2 }] }] });
    assert.ok(texts.includes('?'));
    assert.ok(texts.includes('0'));
    assert.ok(texts.includes('Total Qty: 2'));
  });

  test('many items → page break', async () => {
    await renderSizeRunSheet({ order: { reference: 'R', client_name: 'C', stage: 'ready' }, items: Array.from({ length: 30 }, (_, i) => ({ name: `I${i}`, sizes: [{ size: 'M', qty: 1 }] })) });
    assert.ok(pages >= 1);
  });
});
