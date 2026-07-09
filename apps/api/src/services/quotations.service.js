import PDFDocument from 'pdfkit';
import { query, withTransaction } from '../db/pool.js';
import { listProducts } from './catalog.service.js';
import { parseQuotationRequest, suggestLineItemPricing } from './ai.service.js';
import { sendDocument, uploadMedia } from './whatsapp.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const VAT_RATE  = 15.00;
const SLA_HOURS = 4;

function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ── Daily-resetting quotation reference — BRQ-Q-YYYYMMDD-XXXX ────────────────
async function nextQuotationRef() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO sequence_counters (key, date_key, value)
       VALUES ('quotation', $1, 1)
       ON CONFLICT (key, date_key) DO UPDATE SET value = sequence_counters.value + 1
       RETURNING value`,
      [today]
    );
    return `BRQ-Q-${today}-${String(rows[0].value).padStart(4, '0')}`;
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
    const unitPrice = Number(product.price);
    const sizes     = Array.isArray(item.sizes) && item.sizes.length > 0
      ? item.sizes
      : [{ size: 'TBC', qty: quantity }];
    lineItems.push({
      productId:          product.id,
      name:               product.name,
      category:           product.category,
      colour:             item.colour || '',
      sizes,
      quantity,
      unitPrice,
      brandingSurcharge:  0,
      effectiveUnitPrice: unitPrice,
      branding:           { type: 'none', position: '', detail: '' },
      lineTotal:          unitPrice * quantity,
      priceConfirmed:     true,
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
      suggestedItems = (suggestion.items || []).map((s) => {
        const unitPrice = Number(s.unitPrice);
        return {
          productId:          null,
          name:               s.description,
          category:           'custom',
          colour:             '',
          sizes:              [],
          quantity:           s.quantity,
          unitPrice,
          brandingSurcharge:  0,
          effectiveUnitPrice: unitPrice,
          branding:           { type: 'none', position: '', detail: '' },
          lineTotal:          unitPrice * s.quantity,
          aiNote:             `AI: R${unitPrice}/unit (${s.confidence}) — ${s.notes}`,
          priceConfirmed:     false,
        };
      });
    } catch (err) {
      logger.error('AI pricing suggestion failed — draft saved without suggestions', { error: err.message });
    }
  }

  const allItems  = [...lineItems, ...suggestedItems];
  const currency  = 'ZAR';
  const { subtotal, vatAmount, total } = calcTotals(allItems);
  const slaRemindAt = new Date(Date.now() + SLA_HOURS * 60 * 60 * 1000);
  const reference   = await nextQuotationRef();

  const { rows } = await query(
    `INSERT INTO quotations
       (reference, client_id, status, line_items, subtotal, vat, total, currency, sla_remind_at, notes)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [reference, clientId, JSON.stringify(allItems), subtotal, vatAmount, total, currency, slaRemindAt, freeText]
  );

  return { quotation: rows[0], unmatchedText: unmatchedDescriptions };
}

// ── Consultant approves a draft — recalculates, flips to sent, sends PDF ──────
export async function approveQuotation(id, lineItems, staffId) {
  const existing = await getQuotationById(id);
  if (existing.status !== 'draft') {
    throw new HttpError(400, 'Only draft quotations can be approved');
  }

  // Confirm all items (lineTotal already computed by the builder client-side)
  const confirmedItems = lineItems.map((item) => ({ ...item, priceConfirmed: true }));
  const { subtotal, vatAmount, total } = calcTotals(confirmedItems);

  const { rows } = await query(
    `UPDATE quotations
     SET status      = 'sent',
         line_items  = $1,
         subtotal    = $2,
         vat         = $3,
         total       = $4,
         approved_by = $5,
         approved_at = NOW(),
         updated_at  = NOW()
     WHERE id = $6
     RETURNING *`,
    [JSON.stringify(confirmedItems), subtotal, vatAmount, total, staffId, id]
  );
  const quotation = rows[0];

  // existing already has client data from getQuotationById JOIN
  let whatsappSent = false;
  if (existing.client_wa) {
    try {
      const pdfDoc    = renderQuotationPdf(quotation, {
        name:             existing.client_name,
        organisation:     existing.client_org,
        whatsapp_number:  existing.client_wa,
        physical_address: existing.client_address,
      });
      const pdfBuffer = await pdfToBuffer(pdfDoc);
      const mediaId   = await uploadMedia(pdfBuffer, `${quotation.reference}.pdf`);
      await sendDocument(existing.client_wa, {
        mediaId,
        filename: `${quotation.reference}.pdf`,
        caption:
          `✅ Your quotation is ready! 📄\n\n` +
          `*Ref: ${quotation.reference}*\n` +
          `*Total: R ${Number(total).toFixed(2)} (incl. VAT)*\n\n` +
          `Valid for 7 days. Reply *9* to speak to a consultant.`,
      });
      whatsappSent = true;
    } catch (err) {
      logger.error('Failed to send approved quotation PDF via WhatsApp', {
        quotationId: id,
        error: err.message,
      });
    }
  }

  return { quotation, whatsappSent };
}

// ── AI auto-approve when all items are catalog-matched ────────────────────────
export async function autoApproveQuotation(id, lineItems) {
  const existing = await getQuotationById(id);
  if (existing.status !== 'draft') return null;

  const confirmedItems = lineItems.map((item) => ({ ...item, priceConfirmed: true }));
  const { subtotal, vatAmount, total } = calcTotals(confirmedItems);

  const { rows } = await query(
    `UPDATE quotations
     SET status      = 'sent',
         line_items  = $1,
         subtotal    = $2,
         vat         = $3,
         total       = $4,
         auto_quoted = true,
         updated_at  = NOW()
     WHERE id = $5
     RETURNING *`,
    [JSON.stringify(confirmedItems), subtotal, vatAmount, total, id]
  );
  const quotation = rows[0];

  if (existing.client_wa) {
    try {
      const pdfDoc    = renderQuotationPdf(quotation, {
        name:             existing.client_name,
        organisation:     existing.client_org,
        whatsapp_number:  existing.client_wa,
        physical_address: existing.client_address,
      });
      const pdfBuffer = await pdfToBuffer(pdfDoc);
      const mediaId   = await uploadMedia(pdfBuffer, `${quotation.reference}.pdf`);
      await sendDocument(existing.client_wa, {
        mediaId,
        filename: `${quotation.reference}.pdf`,
        caption:
          `✅ Your quotation is ready! 📄\n\n` +
          `*Ref: ${quotation.reference}*\n` +
          `*Total: R ${Number(total).toFixed(2)} (incl. VAT)*\n\n` +
          `Reply *accept* to confirm, or *9* to speak to a consultant.\n` +
          `Valid for 30 days.`,
      });
    } catch (err) {
      logger.error('Failed to send auto-quoted PDF via WhatsApp', { quotationId: id, error: err.message });
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
            c.organisation    AS client_org,
            assigned.name     AS assigned_name,
            approver.name     AS approved_by_name,
            o.id              AS order_id,
            o.reference       AS order_reference
     FROM quotations q
     LEFT JOIN clients c        ON q.client_id        = c.id
     LEFT JOIN staff   assigned ON q.assigned_staff_id = assigned.id
     LEFT JOIN staff   approver ON q.approved_by       = approver.id
     LEFT JOIN orders  o        ON o.quotation_id      = q.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY q.created_at DESC`,
    params
  );
  return rows;
}

export async function getQuotationById(id) {
  const { rows } = await query(
    `SELECT q.*,
            c.name             AS client_name,
            c.organisation     AS client_org,
            c.whatsapp_number  AS client_wa,
            c.physical_address AS client_address,
            c.client_type,
            o.id               AS order_id
     FROM quotations q
     LEFT JOIN clients c ON c.id = q.client_id
     LEFT JOIN orders o  ON o.quotation_id = q.id
     WHERE q.id = $1`,
    [id]
  );
  if (!rows.length) throw new HttpError(404, 'Quotation not found');
  return rows[0];
}

export async function updateQuotationStatus(id, status) {
  const ALLOWED = ['draft', 'sent', 'accepted', 'rejected'];
  if (!ALLOWED.includes(status)) throw new HttpError(400, `Invalid status: ${status}`);
  const { rows } = await query(
    `UPDATE quotations SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, id]
  );
  if (!rows.length) throw new HttpError(404, 'Quotation not found');
  return rows[0];
}

export async function acceptQuotationByClient(clientId) {
  const { rows } = await query(
    `UPDATE quotations
     SET status = 'accepted', updated_at = NOW()
     WHERE id = (
       SELECT id FROM quotations
       WHERE client_id = $1 AND status = 'sent'
       ORDER BY updated_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [clientId]
  );
  return rows[0] || null;
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
     .text('754B Voortrekker Road, Dalview, Brakpan, Gauteng, South Africa', L, 62)
     .text('info@braquni.com  |  www.braquni.co.za', L, 74);

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

  // Helpers for old-format and new-format line items
  function getPdfItemPrice(item) {
    return Number(item.effectiveUnitPrice ?? item.price ?? 0);
  }
  function getPdfSizesText(item) {
    if (!item.sizes) return null;
    if (typeof item.sizes === 'string') return item.sizes || null;
    const active = item.sizes.filter(s => s.qty > 0);
    return active.length > 0 ? active.map(s => `${s.size}×${s.qty}`).join('   ') : null;
  }
  function getPdfBrandingText(item) {
    if (!item.branding) return null;
    if (typeof item.branding === 'string') return item.branding || null;
    const { type, position, detail } = item.branding;
    if (!type || type === 'none') return null;
    return [type.replace(/_/g, ' '), position?.replace(/_/g, ' '), detail].filter(Boolean).join(' · ');
  }

  // ── Line items ───────────────────────────────────────────────────────────────
  const items = Array.isArray(quotation.line_items) ? quotation.line_items : [];
  let rowNum = 1;

  for (const item of items) {
    const unitPrice    = getPdfItemPrice(item);
    const lineTotal    = Number(item.lineTotal ?? unitPrice * Number(item.quantity ?? 0));
    const nameDisplay  = item.colour
      ? `${item.name ?? item.description ?? '—'} — ${item.colour}`
      : (item.name ?? item.description ?? '—');
    const sizesText    = getPdfSizesText(item);
    const brandingText = getPdfBrandingText(item);
    const subLines     = [];
    if (sizesText)    subLines.push(`Sizes: ${sizesText}`);
    if (brandingText) subLines.push(`Branding: ${brandingText}`);
    const rowH = subLines.length > 1 ? 54 : subLines.length === 1 ? 38 : 22;

    if (rowNum % 2 === 0) doc.rect(L, y, COL, rowH).fill('#fafafa');

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
       .text(String(rowNum),    L + 4,   y + 5, { width: 16 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000')
       .text(nameDisplay, C.desc + 22, y + 5, { width: 238 });
    doc.font('Helvetica').fontSize(9).fillColor('#000000')
       .text(String(item.quantity ?? '—'), C.qty,   y + 5, { width: 60, align: 'center' })
       .text(`R ${unitPrice.toFixed(2)}`,  C.unit,  y + 5, { width: 70, align: 'right' })
       .text(`R ${lineTotal.toFixed(2)}`,  C.total, y + 5, { width: 75, align: 'right' });

    subLines.forEach((line, i) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
         .text(line, C.desc + 22, y + 18 + i * 14, { width: 283 });
    });

    y += rowH + 4;
    rowNum++;

    if (y > 660) {
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
  doc.text(`VAT (15%):`, tX, y, { width: 100 })
     .text(`R ${Number(quotation.vat).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });
  y += 8;
  doc.moveTo(tX, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY)
     .text('TOTAL DUE:', tX, y, { width: 100 })
     .text(`R ${Number(quotation.total).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });
  y += 20;
  doc.rect(tX - 4, y - 4, R - tX + 8, 22).fill('#fff8e6');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#d46b08')
     .text('60% Deposit Required:', tX, y, { width: 130 })
     .text(`R ${(Number(quotation.total) * 0.6).toFixed(2)}`, tValX, y, { width: 90, align: 'right' });

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
