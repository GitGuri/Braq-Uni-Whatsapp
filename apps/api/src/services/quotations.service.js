import PDFDocument from 'pdfkit';
import { query, withTransaction } from '../db/pool.js';
import { listProducts } from './catalog.service.js';
import { parseQuotationRequest } from './ai.service.js';
import { HttpError } from '../utils/httpError.js';

const VAT_RATE = 15.00;

// Sequential, per-year quotation numbering, e.g. BRQ-QT-2026-0012.
async function nextQuotationNumber() {
  const year = new Date().getFullYear();
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO sequence_counters (key, year, value)
       VALUES ('quotation', $1, 1)
       ON CONFLICT (key, year) DO UPDATE SET value = sequence_counters.value + 1
       RETURNING value`,
      [year]
    );
    return `BRQ-QT-${year}-${String(rows[0].value).padStart(4, '0')}`;
  });
}

// ── Build a quotation from a free-text request, grounded in the catalog ──────
export async function createFromFreeText(clientId, freeText) {
  const products = await listProducts({});
  const parsed = await parseQuotationRequest(freeText, { products });
  const productsById = new Map(products.map(p => [p.id, p]));

  const unmatchedText = [...(parsed.unmatchedText || [])];
  const lineItems = [];

  for (const item of parsed.items || []) {
    const product = productsById.get(item.productId);
    if (!product || !item.quantity || item.quantity <= 0) {
      unmatchedText.push(`${item.quantity ?? '?'} x (unrecognised item)`);
      continue;
    }
    const quantity = item.quantity;
    const lineTotal = Number(product.price) * quantity;
    lineItems.push({
      productId: product.id,
      name: product.name,
      category: product.category,
      price: Number(product.price),
      quantity,
      lineTotal,
    });
  }

  const currency = lineItems.length
    ? (productsById.get(lineItems[0].productId)?.currency || 'USD')
    : 'USD';

  const subtotal  = lineItems.reduce((sum, i) => sum + i.lineTotal, 0);
  const vatAmount = subtotal * (VAT_RATE / 100);
  const total     = subtotal + vatAmount;

  const reference = await nextQuotationNumber();
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30-day validity window
  const { rows } = await query(
    `INSERT INTO quotations (reference, client_id, status, line_items, subtotal, vat_rate, vat_amount, total, currency, valid_until, sent_at)
     VALUES ($1,$2,'sent',$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
    [reference, clientId, JSON.stringify(lineItems), subtotal, VAT_RATE, vatAmount, total, currency, validUntil]
  );

  return { quotation: rows[0], unmatchedText };
}

export async function listQuotations() {
  const { rows } = await query('SELECT * FROM quotations ORDER BY created_at DESC');
  return rows;
}

export async function getQuotationById(id) {
  const { rows } = await query('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Quotation not found');
  return rows[0];
}

// ── Look up a quotation by its reference + the client who owns it ────────────
export async function getQuotationByReference(reference, clientId) {
  const { rows } = await query(
    'SELECT * FROM quotations WHERE reference = $1 AND client_id = $2',
    [reference, clientId]
  );
  return rows[0] || null;
}

// ── Render a quotation as a PDF document (not yet ended — caller pipes + ends)
export function renderQuotationPdf(quotation) {
  const doc = new PDFDocument({ margin: 50 });

  doc.fontSize(20).text('Braq Uni — Quotation', { align: 'left' });
  doc.fontSize(10).text(`Reference: ${quotation.reference}`);
  doc.text(`Date: ${new Date(quotation.created_at).toLocaleDateString('en-GB')}`);
  doc.moveDown();

  doc.fontSize(12).text('Item', 50, doc.y, { continued: true, width: 250 });
  doc.text('Qty', 300, doc.y, { continued: true, width: 60 });
  doc.text('Price', 360, doc.y, { continued: true, width: 80 });
  doc.text('Total', 440, doc.y);
  doc.moveDown(0.5);

  for (const item of quotation.line_items) {
    const y = doc.y;
    doc.fontSize(10).text(item.name, 50, y, { width: 250 });
    doc.text(String(item.quantity), 300, y, { width: 60 });
    doc.text(`${quotation.currency} ${item.price.toFixed(2)}`, 360, y, { width: 80 });
    doc.text(`${quotation.currency} ${item.lineTotal.toFixed(2)}`, 440, y);
  }

  doc.moveDown();
  doc.fontSize(11);
  doc.text(`Subtotal: ${quotation.currency} ${Number(quotation.subtotal).toFixed(2)}`, { align: 'right' });
  doc.text(`VAT (${quotation.vat_rate}%): ${quotation.currency} ${Number(quotation.vat_amount).toFixed(2)}`, { align: 'right' });
  doc.fontSize(13).text(`Total: ${quotation.currency} ${Number(quotation.total).toFixed(2)}`, { align: 'right' });

  doc.moveDown(2);
  doc.fontSize(9).text('Thank you for choosing Braq Uni.', { align: 'center' });

  return doc;
}
