// GET /api/meta — the lifecycle vocabulary and business numbers (defined once in
// the backend) plus the caller's permissions, so the dashboard stops duplicating them.
import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { permissionsFor } from '../../core/rbac.js';
import {
  CURRENCY, VAT_RATE_BP, VAT_PERCENT, DEPOSIT_PERCENT, QUOTE_VALIDITY_DAYS, TICKET_SLA_HOURS, QUOTE_SLA_HOURS,
} from '../../core/money.js';
import * as L from '../lifecycle/machines.js';

const labelled = (keys, labels) => keys.map((key) => ({ key, label: labels[key] ?? key }));

/** The static part of /api/meta (everything except the caller's permissions). */
export function metaPayload() {
  return {
    stages:            L.STAGE_META,
    legacyStages:      L.LEGACY_STAGE_MAP,
    jobStates:         L.JOB_STATE_KEYS.map((key) => ({ key, ...L.JOB_STATES[key] })),
    jobJourney:        L.JOB_JOURNEY,
    jobFlags:          Object.entries(L.JOB_FLAGS).map(([key, v]) => ({ key, ...v })),
    jobQueues:         L.JOB_QUEUES,
    quotationStatuses: labelled(L.QUOTATION_STATUSES, L.QUOTATION_STATUS_LABELS),
    paymentStatuses:   labelled(L.PAYMENT_STATUSES, L.PAYMENT_STATUS_LABELS),
    paymentTypes:      L.PAYMENT_TYPES,
    proofStatuses:     labelled(L.PROOF_STATUSES, L.PROOF_STATUS_LABELS),
    ticketStatuses:    labelled(L.TICKET_STATUSES, L.TICKET_STATUS_LABELS),
    ticketCategories:  labelled(L.TICKET_CATEGORIES, L.TICKET_CATEGORY_LABELS),
    clientTypes:       L.CLIENT_TYPES,
    productCategories: L.PRODUCT_CATEGORIES,
    botStates:         L.BOT_STATES,
    humanStates:       L.HUMAN_STATES,
    currency:          CURRENCY,
    vatRate:           VAT_RATE_BP / 10000,
    vatPercent:        VAT_PERCENT,
    depositPercent:    DEPOSIT_PERCENT,
    quoteValidityDays: QUOTE_VALIDITY_DAYS,
    quoteSlaHours:     QUOTE_SLA_HOURS,
    ticketSlaHours:    TICKET_SLA_HOURS,
  };
}

export const metaRouter = express.Router();
metaRouter.use(requireAuth);
metaRouter.get('/', (req, res) => {
  res.json({ ...metaPayload(), role: req.staff.role, permissions: permissionsFor(req.staff) });
});
