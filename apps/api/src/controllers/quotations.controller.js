import { z } from 'zod';
import * as quotationsService from '../services/quotations.service.js';
import { validateQuotation } from '../validators/index.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';
import { query } from '../db/pool.js';

const LineItemSchema = z.object({
  productId:      z.string().nullable().optional(),
  name:           z.string().min(1),
  category:       z.string().optional(),
  price:          z.number().nonnegative(),
  quantity:       z.number().int().positive(),
  lineTotal:      z.number().nonnegative().optional(),
  sizes:          z.string().optional(),
  branding:       z.string().optional(),
  aiSuggested:    z.boolean().optional(),
  priceConfirmed: z.boolean().optional(),
  confidence:     z.string().optional(),
  aiNotes:        z.string().optional(),
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
    const quotation = await quotationsService.approveQuotation(
      req.params.id,
      parsed.data.lineItems,
      req.staff.id,
    );
    logger.info('Quotation approved', {
      quotationId: req.params.id,
      reference: quotation.reference,
      by: req.staff.email,
    });
    res.json({ quotation });
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

    // Draft quotations are not client-facing — treat as not found
    if (quotation.status === 'draft') {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    // Consultant-approved quotations must always render — they've been reviewed.
    // Only block if there are literally no line items to show.
    if (!Array.isArray(quotation.line_items) || quotation.line_items.length === 0) {
      return res.status(422).json({ error: 'Quotation has no line items' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${quotation.reference}.pdf"`);
    const doc = quotationsService.renderQuotationPdf(quotation, {
      client_name:      quotation.client_name,
      whatsapp_number:  quotation.client_wa,
    });
    doc.pipe(res);
    doc.end();
  } catch (err) {
    handleError(res, err, 'Failed to render quotation PDF');
  }
}
