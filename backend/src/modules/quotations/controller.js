import { z } from 'zod';
import * as quotationsService from './service.js';
import { renderQuotationPdf } from './pdf.js';
import { lifecycleForQuotation } from '../jobs/service.js';
import { sendError, validationBody, isUuid } from '../../core/errors.js';
import { paged } from '../../core/http.js';
import { logger } from '../../core/logger.js';
import { query } from '../../core/db.js';  // used by claim() and draftViewer()
import jwt from 'jsonwebtoken';
import { config } from '../../core/config.js';

const SizeEntrySchema = z.object({
  size: z.string().min(1),
  qty:  z.coerce.number().int().nonnegative(),
});

const BrandingSpecSchema = z.object({
  type:     z.enum(['none', 'embroidery', 'screen_print', 'sublimation', 'heat_transfer']).default('none'),
  position: z.string().nullable().optional(),
  detail:   z.string().nullable().optional(),
});

export const LineItemSchema = z.object({
  productId:          z.string().nullable().optional(),
  name:               z.string().min(1),
  category:           z.string().nullable().optional(),
  colour:             z.string().nullable().optional(),
  sizes:              z.array(SizeEntrySchema).default([]),
  quantity:           z.coerce.number().int().positive(),
  unitPrice:          z.coerce.number().finite().nonnegative(),
  brandingSurcharge:  z.coerce.number().finite().nonnegative().default(0),
  // effectiveUnitPrice / lineTotal are accepted but always recomputed server-side
  effectiveUnitPrice: z.coerce.number().finite().nonnegative().optional(),
  branding:           BrandingSpecSchema.nullable().optional(),
  lineTotal:          z.coerce.number().finite().nonnegative().optional(),
  aiNote:             z.string().nullable().optional(),
  priceConfirmed:     z.boolean().optional(),
});

const ApproveSchema = z.object({
  lineItems: z.array(LineItemSchema).min(1),
});

// Staff start a quote from a chat / the client page.
const CreateQuotationSchema = z.object({
  clientId:       z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  lineItems:      z.array(LineItemSchema).max(200).optional(),
  notes:          z.string().max(5000).nullable().optional(),
});

// Autosave of a draft: lines may still be incomplete (no name / quantity yet).
const DraftLineItemSchema = LineItemSchema.extend({
  name:      z.string().max(500).default(''),
  quantity:  z.coerce.number().int().nonnegative().default(0),
  unitPrice: z.coerce.number().finite().nonnegative().default(0),
});
const SaveDraftSchema = z.object({
  lineItems:  z.array(DraftLineItemSchema).max(200).optional(),
  notes:      z.string().max(5000).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)').nullable().optional(),
}).refine((d) => d.lineItems !== undefined || d.notes !== undefined || d.validUntil !== undefined, { message: 'Nothing to save' });

const StatusSchema = z.object({
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired']),
});

/** The quotation (fresh, with order link) + its lifecycle. */
async function withLifecycle(id, staff) {
  const quotation = await quotationsService.getQuotationById(id);
  const lifecycle = await lifecycleForQuotation(quotation, staff);
  return { quotation, lifecycle };
}

function handleError(res, err, fallbackMessage) {
  return sendError(res, err, fallbackMessage);
}

// ── GET /quotations ──────────────────────────────────────────────────────────
// Response: { items, total, page, limit, quotations (legacy key) }; rows carry lifecycle_state
export async function list(req, res) {
  try {
    const { status, search, clientId, page, limit } = req.query;
    const result = await quotationsService.listQuotations({ status, search, clientId: isUuid(clientId) ? clientId : undefined, page, limit });
    paged(res, 'quotations', result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch quotations');
  }
}

export async function getById(req, res) {
  try {
    const { quotation, lifecycle } = await withLifecycle(req.params.id, req.staff);
    res.json({ quotation, lifecycle });
  } catch (err) {
    handleError(res, err, 'Failed to fetch quotation');
  }
}

// ── POST /quotations/:id/approve ─────────────────────────────────────────────
export async function approve(req, res) {
  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

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
    const lifecycle = await lifecycleForQuotation(await quotationsService.getQuotationById(quotation.id), req.staff);
    res.json({ quotation, whatsappSent, lifecycle });
  } catch (err) {
    handleError(res, err, 'Failed to approve quotation');
  }
}

// ── POST /quotations ─────────────────────────────────────────────────────────
// Staff-created draft (assigned to the creator). 201 { quotation, lifecycle }
export async function create(req, res) {
  const parsed = CreateQuotationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const created = await quotationsService.createQuotation(parsed.data, req.staff);
    logger.info('Quotation started by staff', { quotationId: created.id, by: req.staff.email });
    res.status(201).json(await withLifecycle(created.id, req.staff));
  } catch (err) {
    handleError(res, err, 'Failed to create quotation');
  }
}

// ── PUT /quotations/:id ──────────────────────────────────────────────────────
// Autosave a draft (line items, notes, validity). 200 { quotation } | 409 QUOTE_NOT_DRAFT
export async function saveDraft(req, res) {
  const parsed = SaveDraftSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const quotation = await quotationsService.saveDraftQuotation(req.params.id, parsed.data);
    res.json({ quotation });
  } catch (err) {
    handleError(res, err, 'Failed to save the quotation');
  }
}

// ── POST /quotations/:id/resend ──────────────────────────────────────────────
// Queue the quotation PDF to the client again. 202 { queued, quotation }
export async function resend(req, res) {
  try {
    const quotation = await quotationsService.resendQuotation(req.params.id, req.staff);
    res.status(202).json({ queued: true, quotation });
  } catch (err) {
    handleError(res, err, 'Failed to resend quotation');
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
// Mark accepted (sent → accepted), declined (→ rejected), revise (→ draft) …
// through the lifecycle machine. Response: { quotation, lifecycle }
export async function updateStatus(req, res) {
  try {
    if (!req.body?.status) return res.status(400).json({ error: 'status is required' });
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
    await quotationsService.updateQuotationStatus(req.params.id, parsed.data.status, { actorId: req.staff.id });
    res.json(await withLifecycle(req.params.id, req.staff));
  } catch (err) {
    handleError(res, err, 'Failed to update quotation status');
  }
}

/** The signed-in, active staff member behind a Bearer token, or null (no error: the route is public). */
async function draftViewer(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), config.jwt.secret, { algorithms: ['HS256'] });
    const { rows } = await query('SELECT id FROM staff WHERE id = $1 AND is_active = true', [payload.id]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Unauthenticated — Meta's document fetcher needs a plain URL it can GET. A
// draft (still being priced) is only shown to signed-in staff, as a preview.
export async function getPdf(req, res) {
  try {
    const quotation = await quotationsService.getQuotationById(req.params.id);

    if (quotation.status === 'draft' && !(await draftViewer(req))) {
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
    const doc = renderQuotationPdf(quotation, clientInfo);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    handleError(res, err, 'Failed to render quotation PDF');
  }
}
