// Size run sheet — the factory-floor PDF for an order (line items × sizes).
import PDFDocument from 'pdfkit';

/** Render the size run sheet for { order, items } → Promise<Buffer>. */
export async function renderSizeRunSheet({ order, items }) {
  const doc    = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const W     = 595.28;
  const RED   = '#c0392b';
  const DARK  = '#1a1a1a';
  const GREY  = '#666666';
  const LIGHT = '#f5f5f5';
  const L     = 40;

  // Header bar
  doc.rect(0, 0, W, 80).fill(DARK);
  doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
     .text('SIZE RUN SHEET', L, 22);
  doc.fillColor(RED).fontSize(10).font('Helvetica')
     .text('Braq Connect™ — Factory Floor Document', L, 46);
  doc.fillColor('#aaaaaa').fontSize(9)
     .text(`Order: ${order.reference}`, W - 200, 18, { width: 160, align: 'right' })
     .text(`Client: ${order.client_name ?? '—'}`, W - 200, 32, { width: 160, align: 'right' })
     .text(`Printed: ${new Date().toLocaleDateString('en-ZA')}`, W - 200, 46, { width: 160, align: 'right' });

  let y = 100;

  // Client info
  doc.fillColor(DARK).fontSize(10).font('Helvetica-Bold').text('CLIENT', L, y);
  doc.fillColor(GREY).font('Helvetica').text(order.client_name ?? '—', L + 60, y);
  doc.fillColor(DARK).font('Helvetica-Bold').text('STAGE', 300, y);
  doc.fillColor(RED).font('Helvetica').text((order.stage ?? '').replace(/_/g, ' ').toUpperCase(), 360, y);

  y += 22;
  doc.moveTo(L, y).lineTo(W - L, y).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
  y += 14;

  if (!items.length) {
    doc.fillColor(GREY).fontSize(11).text('No line items found for this order.', L, y);
  }

  for (const item of items) {
    const sizes = Array.isArray(item.sizes) ? item.sizes : [];
    const totalQty = sizes.reduce((s, sz) => s + Number(sz.qty ?? 0), 0) || Number(item.quantity ?? 0);

    // Item header
    doc.rect(L, y, W - L * 2, 24).fill(LIGHT);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold')
       .text(item.name ?? 'Unnamed Item', L + 8, y + 6);
    doc.fillColor(RED).fontSize(9).font('Helvetica')
       .text(`Total Qty: ${totalQty}`, W - 130, y + 8, { width: 90, align: 'right' });

    y += 28;

    // Colour
    if (item.colour) {
      doc.fillColor(GREY).fontSize(9).text(`Colour: `, L + 8, y);
      doc.fillColor(DARK).text(item.colour, L + 55, y);
      y += 14;
    }

    // Size table
    if (sizes.length) {
      const colW = Math.min(80, (W - L * 2 - 16) / sizes.length);

      // Size header row
      doc.rect(L + 8, y, colW * sizes.length, 18).fill('#e8e8e8');
      sizes.forEach((sz, i) => {
        doc.fillColor(DARK).fontSize(8).font('Helvetica-Bold')
           .text(sz.size ?? '?', L + 8 + i * colW, y + 4, { width: colW, align: 'center' });
      });
      y += 18;

      // Qty row
      doc.rect(L + 8, y, colW * sizes.length, 20).stroke('#e0e0e0');
      sizes.forEach((sz, i) => {
        doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold')
           .text(String(sz.qty ?? 0), L + 8 + i * colW, y + 4, { width: colW, align: 'center' });
      });
      y += 24;
    } else if (item.quantity) {
      doc.fillColor(GREY).fontSize(9).text(`Quantity: ${item.quantity}`, L + 8, y);
      y += 14;
    }

    // Branding notes (PDFKit has no .italic(); use the oblique standard font)
    if (item.brandingNotes || item.notes) {
      doc.fillColor(GREY).fontSize(8).font('Helvetica-Oblique')
         .text(`Notes: ${item.brandingNotes || item.notes}`, L + 8, y, { width: W - L * 2 - 16 });
      doc.font('Helvetica');
      y += 14;
    }

    // Divider + space
    doc.moveTo(L, y + 4).lineTo(W - L, y + 4).strokeColor('#e0e0e0').lineWidth(0.5).stroke();
    y += 18;

    if (y > 760) { doc.addPage(); y = 40; }
  }

  // Sign-off box
  y = Math.max(y, 700);
  doc.rect(L, y, W - L * 2, 50).stroke('#e0e0e0');
  doc.fillColor(GREY).fontSize(8).text('Checked by: _____________________   Signature: _____________________   Date: ____________', L + 8, y + 18, { width: W - L * 2 - 16 });

  const ended = new Promise((resolve) => doc.on('end', resolve));
  doc.end();
  await ended;
  return Buffer.concat(chunks);
}
