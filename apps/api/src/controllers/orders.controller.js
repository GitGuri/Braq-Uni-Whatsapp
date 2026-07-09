import { z } from 'zod';
import PDFDocument from 'pdfkit';
import * as ordersService from '../services/orders.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const CLIENT_TYPES = ['retail','school','corporate','hospitality','church','security','government','reseller'];

const CreateOrderSchema = z.object({
  clientId:        z.string().uuid(),
  clientType:      z.enum(CLIENT_TYPES).default('retail'),
  quotationId:     z.string().uuid().optional(),
  poNumber:        z.string().optional(),
  assignedStaffId: z.string().uuid().optional(),
});

const AdvanceStageSchema = z.object({
  notes:               z.string().optional(),
  estimatedCompletion: z.string().optional(),
  trackingNumber:      z.string().optional(),
  deliveryType:        z.enum(['collection','delivery']).optional().default('collection'),
});

const RecordPaymentSchema = z.object({
  type:     z.enum(['deposit', 'balance', 'full']),
  amount:   z.number().positive(),
  currency: z.string().length(3).default('ZAR'),
  notes:    z.string().optional(),
});

const HoldSchema = z.object({
  isOnHold:   z.boolean(),
  holdReason: z.string().optional(),
});

const ConvertSchema = z.object({
  poNumber:        z.string().optional(),
  assignedStaffId: z.string().uuid().optional(),
});

function handleError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallback, { error: err.message });
  return res.status(500).json({ error: fallback });
}

// ── GET /orders ──────────────────────────────────────────────────────────────
export async function list(req, res) {
  try {
    const orders = await ordersService.listOrders(req.query);
    res.json({ orders });
  } catch (err) { handleError(res, err, 'Failed to fetch orders'); }
}

// ── GET /orders/kpis ─────────────────────────────────────────────────────────
export async function kpis(req, res) {
  try {
    const data = await ordersService.getDashboardKpis();
    res.json(data);
  } catch (err) { handleError(res, err, 'Failed to fetch KPIs'); }
}

// ── GET /orders/:id ──────────────────────────────────────────────────────────
export async function getById(req, res) {
  try {
    const result = await ordersService.getOrderById(req.params.id);
    const info = ordersService.getStageInfo(result.order.stage);
    res.json({ ...result, stageInfo: info });
  } catch (err) { handleError(res, err, 'Failed to fetch order'); }
}

// ── POST /orders ─────────────────────────────────────────────────────────────
export async function create(req, res) {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.createOrder({ ...parsed.data, assignedStaffId: parsed.data.assignedStaffId || req.staff.id });
    res.status(201).json({ order });
  } catch (err) { handleError(res, err, 'Failed to create order'); }
}

// ── POST /orders/:id/convert-from-quotation ──────────────────────────────────
export async function convertFromQuotation(req, res) {
  const parsed = ConvertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.convertFromQuotation(req.params.id, req.staff.id, parsed.data);
    logger.info('Quotation converted to order', { quotationId: req.params.id, orderId: order.id, by: req.staff.email });
    res.status(201).json({ order });
  } catch (err) { handleError(res, err, 'Failed to convert quotation to order'); }
}

// ── POST /orders/:id/advance ─────────────────────────────────────────────────
export async function advance(req, res) {
  const parsed = AdvanceStageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { order, from, to } = await ordersService.advanceOrderStage(req.params.id, req.staff.id, parsed.data);
    logger.info('Order stage advanced', { orderId: req.params.id, from, to, by: req.staff.email });
    res.json({ order, from, to });
  } catch (err) { handleError(res, err, 'Failed to advance order stage'); }
}

// ── PATCH /orders/:id/hold ───────────────────────────────────────────────────
export async function hold(req, res) {
  const parsed = HoldSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await ordersService.setOrderHold(req.params.id, parsed.data);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update hold status'); }
}

// ── PATCH /orders/:id/assign ─────────────────────────────────────────────────
export async function assign(req, res) {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId required' });

  try {
    const order = await ordersService.assignOrder(req.params.id, staffId);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to assign consultant'); }
}

// ── POST /orders/:id/payments ────────────────────────────────────────────────
export async function recordPayment(req, res) {
  const parsed = RecordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const payment = await ordersService.recordPayment(req.params.id, parsed.data);
    res.status(201).json({ payment });
  } catch (err) { handleError(res, err, 'Failed to record payment'); }
}

// ── GET /orders/:id/payments ─────────────────────────────────────────────────
export async function listPayments(req, res) {
  try {
    const payments = await ordersService.listPayments(req.params.id);
    res.json({ payments });
  } catch (err) { handleError(res, err, 'Failed to fetch payments'); }
}

// ── PATCH /orders/:id/materials ──────────────────────────────────────────────
export async function updateMaterials(req, res) {
  try {
    const order = await ordersService.updateMaterialNotes(req.params.id, req.body);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update material notes'); }
}

// ── POST /orders/:id/proof ───────────────────────────────────────────────────
export async function sendProof(req, res) {
  const { proofUrl, notes } = req.body;
  if (!proofUrl) return res.status(400).json({ error: 'proofUrl is required' });
  try {
    const order = await ordersService.sendProofToClient(req.params.id, proofUrl, notes);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to send proof'); }
}

// ── PATCH /orders/:id/proof/status ───────────────────────────────────────────
export async function updateProofStatus(req, res) {
  const { status, notes } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  try {
    const order = await ordersService.updateProofStatus(req.params.id, status, notes);
    res.json({ order });
  } catch (err) { handleError(res, err, 'Failed to update proof status'); }
}

// ── GET /orders/:id/size-run-sheet ───────────────────────────────────────────
export async function sizeRunSheet(req, res) {
  try {
    const { order, items } = await ordersService.getSizeRunSheetData(req.params.id);

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
       .text(`Order: ${order.reference}`, W - 180, 22, { width: 140, align: 'right' })
       .text(`Printed: ${new Date().toLocaleDateString('en-ZA')}`, W - 180, 36, { width: 140, align: 'right' });

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

      // Branding notes
      if (item.brandingNotes || item.notes) {
        doc.fillColor(GREY).fontSize(8).font('Helvetica').italic()
           .text(`Notes: ${item.brandingNotes || item.notes}`, L + 8, y, { width: W - L * 2 - 16 });
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

    doc.end();

    await new Promise((resolve) => doc.on('end', resolve));

    const pdf = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="size-run-${order.reference}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  } catch (err) { handleError(res, err, 'Failed to generate size run sheet'); }
}
