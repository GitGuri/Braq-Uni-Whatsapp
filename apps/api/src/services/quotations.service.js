import PDFDocument from 'pdfkit';
import { query, withTransaction } from '../db/pool.js';
import { listProducts } from './catalog.service.js';
import { parseQuotationRequest, suggestLineItemPricing } from './ai.service.js';
import { sendDocument, uploadMedia } from './whatsapp.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const VAT_RATE   = 15.00;
const SLA_HOURS  = 4;

function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ── Sequential per-year quotation numbering — BRQ-QT-2026-0012 ───────────────
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

function calcTotals(lineItems) {
  const subtotal  = lineItems.reduce((s, i) => s + Number(i.lineTotal ?? 0), 0);
  const vatAmount = subtotal * (VAT_RATE / 100);
  return { subtotal, vatAmount, total: subtotal + vatAmount };
}

// ── Build a quotation from a free-text request, grounded in the catalog ───────
export async function createFromFreeText(clientId, freeText) {
  const products    = await listProducts({});
  const parsed      = await parseQuotationRequest(freeText, { products });
  const productsById = new Map(products.map(p => [p.id, p]));

  const unmatchedDescriptions = [...(parsed.unmatchedText || [])];
  const lineItems = [];

  for (const item of parsed.items || []) {
    const product = productsById.get(item.productId);
    if (!product || !item.quantity || item.quantity <= 0) {
      unmatchedDescriptions.push(item.description || `${item.quantity ?? '?'} × unrecognised item`);
      continue;
    }
    const quantity  = item.quantity;
    const lineTotal = Number(product.price) * quantity;
    lineItems.push({
      productId: product.id,
      name:      product.name,
      category:  product.category,
      price:     Number(product.price),
      quantity,
      lineTotal,
      sizes:          item.sizes || null,
      aiSuggested:    false,
      priceConfirmed: true,
    });
  }

  // If any items are unmatched, ask AI to suggest prices so the consultant
  // has a head-start rather than pricing from scratch.
  let suggestedItems = [];
  if (unmatchedDescriptions.length > 0) {
    try {
      const suggestion = await suggestLineItemPricing(unmatchedDescriptions, {
        products,
        originalRequest: freeText,
      });
      suggestedItems = (suggestion.items || []).map((s) => ({
        productId:      null,
        name:           s.description,
        category:       'custom',
        price:          Number(s.unitPrice),
        quantity:       s.quantity,
        lineTotal:      Number(s.unitPrice) * s.quantity,
        sizes:          s.sizes || 'TBC',
        branding:       s.branding || 'TBC',
        aiSuggested:    true,
        priceConfirmed: false,
        confidence:     s.confidence,
        aiNotes:        s.notes,
      }));
    } catch (err) {
      logger.error('AI pricing suggestion failed — draft saved without suggestions', { error: err.message });
    }
  }

  const allItems  = [...lineItems, ...suggestedItems];
  const currency  = 'ZAR';
  const { subtotal, vatAmount, total } = calcTotals(allItems);

  // Always draft — consultant reviews and approves before PDF is sent to client.
  const status      = 'draft';
  const slaRemindAt = new Date(Date.now() + SLA_HOURS * 60 * 60 * 1000);

  const reference  = await nextQuotationNumber();
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const sentAt     = status === 'sent' ? new Date() : null;

  const { rows } = await query(
    `INSERT INTO quotations
       (reference, client_id, status, line_items, subtotal, vat_rate, vat_amount,
        total, currency, valid_until, sla_remind_at, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [reference, clientId, status, JSON.stringify(allItems),
     subtotal, VAT_RATE, vatAmount, total, currency, validUntil, slaRemindAt, sentAt]
  );

  return { quotation: rows[0], unmatchedText: unmatchedDescriptions };
}

// ── Consultant approves a draft — recalculates, flips to sent, sends PDF ──────
export async function approveQuotation(id, lineItems, staffId) {
  const existing = await getQuotationById(id);
  if (existing.status !== 'draft') {
    throw new HttpError(400, 'Only draft quotations can be approved');
  }

  // Mark every line item as confirmed and recalculate
  const confirmedItems = lineItems.map((item) => ({
    ...item,
    lineTotal:      Number(item.price) * Number(item.quantity),
    priceConfirmed: true,
  }));

  const { subtotal, vatAmount, total } = calcTotals(confirmedItems);
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const { rows } = await query(
    `UPDATE quotations
     SET status       = 'sent',
         line_items   = $1,
         subtotal     = $2,
         vat_amount   = $3,
         total        = $4,
         valid_until  = $5,
         approved_by  = $6,
         approved_at  = NOW(),
         sent_at      = NOW(),
         updated_at   = NOW()
     WHERE id = $7
     RETURNING *`,
    [JSON.stringify(confirmedItems), subtotal, vatAmount, total, validUntil, staffId, id]
  );
  const quotation = rows[0];

  // Send PDF to client via WhatsApp — generate in-memory and upload directly
  // so we are never dependent on a publicly accessible API_BASE_URL.
  const clientRow = await query('SELECT * FROM clients WHERE id = $1', [quotation.client_id]);
  const clientData = clientRow.rows[0];
  if (clientData?.whatsapp_number) {
    try {
      const pdfDoc    = renderQuotationPdf(quotation, {
        client_name:     clientData.name,
        whatsapp_number: clientData.whatsapp_number,
      });
      const pdfBuffer = await pdfToBuffer(pdfDoc);
      const mediaId   = await uploadMedia(pdfBuffer, `${quotation.reference}.pdf`);
      await sendDocument(clientData.whatsapp_number, {
        mediaId,
        filename: `${quotation.reference}.pdf`,
        caption:
          `✅ Your quotation is ready! 📄\n\n` +
          `*Ref: ${quotation.reference}*\n` +
          `*Total: R ${Number(total).toFixed(2)} (incl. VAT)*\n\n` +
          `Valid for 30 days. Reply *po* to submit a purchase order or *9* to speak to a consultant.`,
      });
    } catch (err) {
      logger.error('Failed to send approved quotation PDF via WhatsApp', {
        quotationId: id,
        error: err.message,
      });
    }
  }

  return quotation;
}

// ── List quotations ───────────────────────────────────────────────────────────
export async function listQuotations({ status } = {}) {
  const params = [];
  const where  = status ? [`q.status = $${params.push(status)}`] : [];
  const { rows } = await query(
    `SELECT q.*,
            c.name            AS client_name,
            c.whatsapp_number AS client_wa,
            s.name            AS approved_by_name
     FROM quotations q
     LEFT JOIN clients c ON q.client_id  = c.id
     LEFT JOIN staff   s ON q.approved_by = s.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY q.created_at DESC`,
    params
  );
  return rows;
}

export async function getQuotationById(id) {
  const { rows } = await query('SELECT * FROM quotations WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Quotation not found');
  return rows[0];
}

export async function getQuotationByReference(reference, clientId) {
  const { rows } = await query(
    'SELECT * FROM quotations WHERE reference = $1 AND client_id = $2',
    [reference, clientId]
  );
  return rows[0] || null;
}

// ── Professional PDF renderer ─────────────────────────────────────────────────
export function renderQuotationPdf(quotation, clientInfo = {}) {
  const doc     = new PDFDocument({ margin: 0, size: 'A4' });
  const W       = 595.28;
  const NAVY    = '#001529';
  const BLUE    = '#1677ff';
  const LIGHT   = '#f0f4ff';
  const GREY    = '#666666';
  const DIVIDER = '#e0e0e0';
  const L       = 40;   // left margin
  const R       = W - 40; // right edge
  const COL     = R - L;

  // ── Header band ────────────────────────────────────────────────────────────
  doc.rect(0, 0, W, 110).fill(NAVY);

  doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff')
     .text('BRAQ UNI', L, 22);
  doc.font('Helvetica').fontSize(9).fillColor('#8fb8d8')
     .text('Your Uniform Stylist', L, 48);
  doc.font('Helvetica').fontSize(8).fillColor('#8fb8d8')
     .text('Corner Leeuwkop Rd & Rivonia Blvd, Sunninghill, Sandton', L, 62)
     .text('Tel: 011 234 5678  |  info@braquni.com  |  www.braquni.co.za', L, 74);

  // Quotation title (right side of header)
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff')
     .text('QUOTATION', 0, 22, { align: 'right', width: R });
  doc.font('Helvetica').fontSize(9).fillColor('#8fb8d8')
     .text(`Ref: ${quotation.reference}`, 0, 50, { align: 'right', width: R })
     .text(`Date: ${new Date(quotation.created_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}`, 0, 63, { align: 'right', width: R })
     .text(`Valid Until: ${quotation.valid_until ? new Date(quotation.valid_until).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '30 days from date'}`, 0, 76, { align: 'right', width: R });

  // ── Bill To block ───────────────────────────────────────────────────────────
  let y = 128;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('BILL TO:', L, y);
  y += 14;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
     .text(clientInfo.name || quotation.client_name || 'Valued Client', L, y);
  y += 13;
  if (clientInfo.organisation) {
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(clientInfo.organisation, L, y);
    y += 12;
  }
  if (clientInfo.whatsapp_number || clientInfo.client_wa) {
    doc.font('Helvetica').fontSize(9).fillColor(GREY)
       .text(`WhatsApp: ${clientInfo.whatsapp_number || clientInfo.client_wa}`, L, y);
    y += 12;
  }
  if (clientInfo.physical_address) {
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(clientInfo.physical_address, L, y);
    y += 12;
  }

  // ── Divider ─────────────────────────────────────────────────────────────────
  y += 10;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 14;

  // ── Line items table header ──────────────────────────────────────────────────
  const C = { desc: L, qty: L + 270, unit: L + 340, total: L + 420 };
  doc.rect(L, y, COL, 20).fill(LIGHT);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY);
  doc.text('#',           L + 4,  y + 6, { width: 16 });
  doc.text('DESCRIPTION', C.desc + 22, y + 6, { width: 240 });
  doc.text('QTY',         C.qty,  y + 6, { width: 60,  align: 'center' });
  doc.text('UNIT PRICE',  C.unit, y + 6, { width: 70,  align: 'right' });
  doc.text('LINE TOTAL',  C.total, y + 6, { width: 75, align: 'right' });
  y += 22;

  // ── Line items ───────────────────────────────────────────────────────────────
  const items = Array.isArray(quotation.line_items) ? quotation.line_items : [];
  let rowNum = 1;

  for (const item of items) {
    // Shade alternate rows
    if (rowNum % 2 === 0) {
      doc.rect(L, y, COL, 28).fill('#fafafa');
    }

    const unitPrice = Number(item.price  ?? 0);
    const lineTotal = Number(item.lineTotal ?? unitPrice * Number(item.quantity ?? 0));
    const subLines  = [];
    if (item.sizes   && item.sizes   !== 'TBC') subLines.push(`Sizes: ${item.sizes}`);
    if (item.branding && item.branding !== 'None' && item.branding !== 'TBC')
      subLines.push(`Branding: ${item.branding}`);
    const rowH = subLines.length > 0 ? 38 : 22;

    if (rowNum % 2 === 0) doc.rect(L, y, COL, rowH).fill('#fafafa');

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
       .text(String(rowNum),    L + 4,   y + 5, { width: 16 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
       .text(item.name || item.description || '—', C.desc + 22, y + 5, { width: 238 });
    doc.font('Helvetica').fontSize(9).fillColor('#000000')
       .text(String(item.quantity ?? '—'), C.qty,   y + 5, { width: 60, align: 'center' })
       .text(`R ${unitPrice.toFixed(2)}`,  C.unit,  y + 5, { width: 70, align: 'right' })
       .text(`R ${lineTotal.toFixed(2)}`,  C.total, y + 5, { width: 75, align: 'right' });

    if (subLines.length > 0) {
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
         .text(subLines.join('   ·   '), C.desc + 22, y + 18, { width: 273 });
    }

    // AI-suggested badge
    if (item.aiSuggested && !item.priceConfirmed) {
      doc.font('Helvetica').fontSize(7).fillColor('#d46b08')
         .text('AI estimate', C.total, y + 18, { width: 75, align: 'right' });
    }

    y += rowH + 4;
    rowNum++;

    // Page break guard
    if (y > 680) {
      doc.addPage({ margin: 0 });
      y = 40;
    }
  }

  // ── Totals block ─────────────────────────────────────────────────────────────
  y += 6;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 12;

  const tX    = R - 200;
  const tValX = R - 95;

  doc.font('Helvetica').fontSize(9).fillColor(GREY)
     .text('Subtotal:',    tX, y, { width: 100 })
     .text(`R ${Number(quotation.subtotal).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });
  y += 14;
  doc.text(`VAT (${quotation.vat_rate ?? 15}%):`, tX, y, { width: 100 })
     .text(`R ${Number(quotation.vat_amount).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });
  y += 8;
  doc.moveTo(tX, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY)
     .text('TOTAL DUE:', tX, y, { width: 100 })
     .text(`R ${Number(quotation.total).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });

  // ── Payment terms + banking ───────────────────────────────────────────────────
  y += 36;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 14;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('PAYMENT TERMS:', L, y);
  y += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
     .text('• 60% deposit required before production commences', L, y);
  y += 12;
  doc.text('• Balance due before collection or delivery', L, y);
  y += 12;
  doc.text('• EFT payments only — no cash or cheques accepted', L, y);

  y += 20;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('BANKING DETAILS:', L, y);
  y += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
     .text('Bank: First National Bank (FNB)  |  Account Name: Braq Uni (Pty) Ltd', L, y);
  y += 12;
  doc.text('Account No: 123 456 789  |  Branch Code: 250 655  |  Type: Cheque', L, y);

  // ── Footer band ──────────────────────────────────────────────────────────────
  const footerY = 790;
  doc.rect(0, footerY, W, 51.89).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
     .text('Thank you for choosing Braq Uni — Your Uniform Stylist', 0, footerY + 10, { align: 'center', width: W });
  doc.font('Helvetica').fontSize(7.5).fillColor('#8fb8d8')
     .text('This quotation is valid for 30 days from the date of issue and is subject to stock availability.', 0, footerY + 24, { align: 'center', width: W })
     .text('Prices are inclusive of VAT at 15%. E&OE.', 0, footerY + 35, { align: 'center', width: W });

  return doc;
}
