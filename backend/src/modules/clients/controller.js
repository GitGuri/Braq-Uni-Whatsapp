import { z } from 'zod';
import * as clientsService from './service.js';
import { HttpError, sendError, validationBody, isUuid } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { paged } from '../../core/http.js';

const CLIENT_TYPES = ['retail','school','corporate','hospitality','church','security','government','reseller'];

// Optional text field: trimmed; '' or null clears the column. max = DB column size.
const optText = (max) => z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v),
  z.string().max(max).nullable().optional(),
);

// Lengths match the clients table (migrate.js): VARCHAR(200) name/email/
// organisation/contact_person/school_name, VARCHAR(120) preferred_store_location,
// VARCHAR(50) vat_number, VARCHAR(20) delivery_preference; physical_address is TEXT.
const UpdateClientSchema = z.object({
  name:          optText(200),
  email:         z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v),
    z.string().max(200).email().nullable().optional(),
  ),
  // client_type is NOT NULL — null / '' mean "leave unchanged".
  clientType:    z.preprocess((v) => (v === null || v === '' ? undefined : v), z.enum(CLIENT_TYPES).optional()),
  organisation:  optText(200),
  contactPerson: optText(200),
  notes:         optText(2000),
  physicalAddress:        optText(1000),
  vatNumber:              optText(50),
  preferredStoreLocation: optText(120),
  schoolName:             optText(200),
  deliveryPreference:     optText(20),
});

// The dashboard edit form historically sent snake_case column names; accept
// those too (camelCase wins if both are present).
const SNAKE_TO_CAMEL = Object.fromEntries(
  Object.entries(clientsService.DASHBOARD_FIELD_MAP ?? {}).map(([camel, col]) => [col, camel])
);

function normaliseClientBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const camel = SNAKE_TO_CAMEL[key];
    if (camel && camel !== key) {
      if (!(camel in body)) out[camel] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const ListQuerySchema = z.object({
  clientType: z.enum(CLIENT_TYPES).optional(),
});

function handleError(res, err, fallbackMessage) {
  return sendError(res, err, fallbackMessage);
}

function rejectBadId(req, res) {
  if (isUuid(req.params.id)) return false;
  res.status(400).json({ error: 'Invalid client id' });
  return true;
}

// ── GET /clients ────────────────────────────────────────────────────────────────
// Response: { items, total, page, limit, clients (legacy key) }
export async function list(req, res) {
  const filters = ListQuerySchema.safeParse({ clientType: req.query.clientType || undefined });
  if (!filters.success) return res.status(400).json(validationBody(filters.error));

  try {
    const result = await clientsService.listClients({ ...req.query, ...filters.data });
    paged(res, 'clients', result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch clients');
  }
}

// ── GET /clients/:id ──────────────────────────────────────────────────────────
export async function getById(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    const result = await clientsService.getClientById(req.params.id);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Failed to fetch client');
  }
}

// ── PATCH /clients/:id ─────────────────────────────────────────────────────────
export async function update(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = UpdateClientSchema.safeParse(normaliseClientBody(req.body));
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const client = await clientsService.updateClient(req.params.id, parsed.data);
    res.json({ client });
  } catch (err) {
    handleError(res, err, 'Failed to update client');
  }
}

// ── PATCH /clients/:id/account-terms ──────────────────────────────────────────
// { accountTerms: boolean } — admin / manager ('client.terms'). → { client }
const AccountTermsSchema = z.object({ accountTerms: z.boolean() });
export async function setAccountTerms(req, res) {
  if (rejectBadId(req, res)) return;
  const parsed = AccountTermsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const client = await clientsService.setAccountTerms(req.params.id, parsed.data.accountTerms, req.staff);
    logger.info('Client account terms changed', { clientId: req.params.id, accountTerms: parsed.data.accountTerms, by: req.staff.email });
    res.json({ client });
  } catch (err) {
    handleError(res, err, 'Failed to change account terms');
  }
}

// ── POST /clients/:id/conversation ────────────────────────────────────────────
// Open the client's chat (created when there is none). → 200 | 201 { conversation, created }
export async function openConversation(req, res) {
  if (rejectBadId(req, res)) return;
  try {
    const result = await clientsService.openConversationForClient(req.params.id);
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    handleError(res, err, 'Failed to open the conversation');
  }
}
