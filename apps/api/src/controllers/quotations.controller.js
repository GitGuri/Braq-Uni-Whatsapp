import { z } from 'zod';
import * as quotationsService from '../services/quotations.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';
import { query } from '../db/pool.js';  // used by claim()

const SizeEntrySchema = z.object({
  size: z.string().min(1),
  qty:  z.coerce.number().int().nonnegative(),
});

const BrandingSpecSchema = z.object({
  type:     z.enum(['none', 'embroidery', 'screen_print', 'sublimation', 'heat_transfer']).default('none'),
  position: z.string().nullable().optional(),
  detail:   z.string().nullable().optional(),
});

const LineItemSchema = z.object({
  productId:          z.string().nullable().optional(),
  name:               z.string().min(1),
  category:           z.string().nullable().optional(),
  colour:             z.string().nullable().optional(),
  sizes:              z.array(SizeEntrySchema).default([]),
  quantity:           z.coerce.number().int().nonnegative(),
  unitPrice:          z.coerce.number().nonnegative(),
  brandingSurcharge:  z.coerce.number().nonnegative().default(0),
  effectiveUnitPrice: z.coerce.number().nonnegative(),
  branding:           BrandingSpecSchema.nullable().optional(),
  lineTotal:          z.coerce.number().nonnegative(),
  aiNote:             z.string().nullable().optional(),
  priceConfirmed:     z.boolean().optional(),
});

const ApproveSchema = z.object({
  lineItems: z.array(LineItemSchema).min(1),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

export async function list(req, res) {
  try {
    const quotations = await quotationsService.listQuotations({ status: req.query.status });
    res.json({ quotations });
  } catch (err) {
    handleError(res, err, 'Failed to fetch quotations');
  }
}

export async function getById(req, res) {
  try {
    const quotation = await quotationsService.getQuotationById(req.params.id);
    res.json({ quotation });
  } catch (err) {
    handleError(res, err, 'Failed to fetch quotation');
  }
}

// ── POST /quotations/:id/approve ─────────────────────────────────────────────
export async function approve(req, res) {
  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { quotation, whatsappSent } = await quotationsService.approveQuotation(
      req.params.id,
      parsed.data.lineItems,
      req.staff.id,
    );
    logger.info('Quotation approved', {
      quotationId: req.params.id,
      reference: quotation.reference,
      by: req.staff.email,
      whatsappSent,
    });
    res.json({ quotation, whatsappSent });
  } catch (err) {
    handleError(res, err, 'Failed to approve quotation');
  }
}

// ── POST /quotations/:id/claim ────────────────────────────────────────────────
// Atomic first-to-claim — only succeeds if assigned_staff_id IS NULL
export async function claim(req, res) {
  try {
    const { rows } = await query(
      `UPDATE quotations
       SET assigned_staff_id = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND assigned_staff_id IS NULL
       RETURNING *`,
      [req.staff.id, req.params.id]
    );

    if (rows.length) return res.json({ quotation: rows[0] });

    // Someone else claimed it — find out who
    const { rows: current } = await query(
      `SELECT q.id, s.name AS claimer_name
       FROM quotations q
       LEFT JOIN staff s ON s.id = q.assigned_staff_id
       WHERE q.id = $1`,
      [req.params.id]
    );
    if (!current.length) return res.status(404).json({ error: 'Quotation not found' });

    return res.status(409).json({
      error: `Already claimed by ${current[0].claimer_name ?? 'another consultant'}`,
    });
  } catch (err) {
    handleError(res, err, 'Failed to claim quotation');
  }
}

// ── PATCH /quotations/:id/status ─────────────────────────────────────────────
export async function updateStatus(req, res) {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const quotation = await quotationsService.updateQuotationStatus(req.params.id, status);
    res.json({ quotation });
  } catch (err) {
    handleError(res, err, 'Failed to update quotation status');
  }
}

// Unauthenticated — Meta's document fetcher needs a plain URL it can GET.
export async function getPdf(req, res) {
  try {
    const quotation = await quotationsService.getQuotationById(req.params.id);

    if (quotation.status === 'draft') {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    if (!Array.isArray(quotation.line_items) || quotation.line_items.length === 0) {
      return res.status(422).json({ error: 'Quotation has no line items' });
    }

    // getQuotationById now JOINs clients — client info is already on the quotation object
    const clientInfo = {
      name:             quotation.client_name,
      organisation:     quotation.client_org,
      whatsapp_number:  quotation.client_wa,
      physical_address: quotation.client_address,
    };

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.reference}.pdf"`);
    const doc = quotationsService.renderQuotationPdf(quotation, clientInfo);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    handleError(res, err, 'Failed to render quotation PDF');
  }
}
