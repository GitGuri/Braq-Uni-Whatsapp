// Quotation PDF (A4, pdfkit) — pure rendering, no I/O.
import PDFDocument from 'pdfkit';
import { toCents, splitDeposit, centsToFixed, VAT_PERCENT, DEPOSIT_PERCENT, QUOTE_VALIDITY_DAYS } from '../../core/money.js';

const SA_TZ = 'Africa/Johannesburg';
const VALIDITY_DAYS = QUOTE_VALIDITY_DAYS;

/** Collect a pdfkit document into a Buffer (ends the document). */
export function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
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
     .text(`Date: ${new Date(quotation.created_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: SA_TZ })}`, 0, 63, { align: 'right', width: R })
     .text(`Valid Until: ${quotation.valid_until ? new Date(quotation.valid_until).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: SA_TZ }) : `${VALIDITY_DAYS} days from date`}`, 0, 76, { align: 'right', width: R });

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
  doc.text(`VAT (${VAT_PERCENT}%):`, tX, y, { width: 100 })
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
     .text(`${DEPOSIT_PERCENT}% Deposit Required:`, tX, y, { width: 130 })
     .text(`R ${centsToFixed(splitDeposit(toCents(quotation.total)).depositCents)}`, tValX, y, { width: 90, align: 'right' });

  // ── Payment terms ───────────────────────────────────────────────────
  y += 36;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(DIVIDER).stroke();
  y += 14;

  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('PAYMENT TERMS:', L, y);
  y += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
     .text(`• ${DEPOSIT_PERCENT}% deposit required before production commences`, L, y);
  y += 12;
  doc.text('• Balance due before collection or delivery', L, y);
  y += 12;
  doc.text('• EFT payments only — no cash or cheques accepted', L, y);

  y += 20;
  // Payment details are arranged by the consultant (never printed on the quote).
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('PAYMENT DETAILS:', L, y);
  y += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(GREY)
     .text('Payment details will be provided by your consultant.', L, y);

  // ── Footer band ──────────────────────────────────────────────────────────────
  const footerY = 790;
  doc.rect(0, footerY, W, 51.89).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
     .text('Thank you for choosing Braq Uni — Your Uniform Stylist', 0, footerY + 10, { align: 'center', width: W });
  doc.font('Helvetica').fontSize(7.5).fillColor('#8fb8d8')
     .text(`This quotation is valid for ${VALIDITY_DAYS} days from the date of issue and is subject to stock availability.`, 0, footerY + 24, { align: 'center', width: W })
     .text(`All prices exclude VAT; VAT at ${VAT_PERCENT}% is added to the subtotal. E&OE.`, 0, footerY + 35, { align: 'center', width: W });

  return doc;
}
