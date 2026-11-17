import { ZodError } from 'zod';
import { logger } from './logger.js';

export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {object} [extra] extra JSON fields (e.g. { code }) */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) this.extra = extra;
  }
}

// Postgres error codes caused by bad client input rather than a server fault
const PG_CLIENT_ERRORS = {
  '22P02': [400, 'Invalid id or value format'],          // invalid_text_representation (bad uuid/enum/int)
  '22007': [400, 'Invalid date'],                        // invalid_datetime_format
  '22008': [400, 'Invalid date'],                        // datetime_field_overflow
  '22001': [400, 'Value too long'],                      // string_data_right_truncation
  '22003': [400, 'Number out of range'],                 // numeric_value_out_of_range
  '2201W': [400, 'Invalid limit'],                       // invalid_row_count_in_limit_clause
  '2201X': [400, 'Invalid page'],                        // invalid_row_count_in_result_offset_clause
  '23503': [400, 'Referenced record does not exist'],    // foreign_key_violation
  '23505': [409, 'Record already exists'],               // unique_violation
};

/** Map any error to { status, message }; unknown errors become 500 with the fallback message. */
export function toHttpError(err, fallback = 'Internal server error') {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  const mapped = err?.code && PG_CLIENT_ERRORS[err.code];
  if (mapped) return { status: mapped[0], message: mapped[1] };
  return { status: 500, message: fallback };
}

/** Shared controller error responder. Logs only genuine server errors. */
export function sendError(res, err, fallback) {
  const { status, message } = toHttpError(err, fallback);
  if (status >= 500) logger.error(fallback, { error: err?.message });
  return res.status(status).json({ error: message, ...(err instanceof HttpError && err.extra ? err.extra : {}) });
}

/** 400 body for a failed zod parse: a readable string in `error`, field detail in `details`. */
export function validationBody(zodError) {
  const flat = zodError.flatten();
  const fieldMsgs = Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`);
  return { error: [...flat.formErrors, ...fieldMsgs].join('; ') || 'Invalid request', details: flat };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Clamp page/limit query params to sane positive integers. */
export function pageParams(query, { defaultLimit = 20, maxLimit = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * The single Express error middleware (mounted last in app.js).
 *  - ZodError                           → 400 validationBody
 *  - body-parser errors (malformed JSON 400, body too large 413) and any other
 *    err.status 4xx                     → that status
 *  - HttpError / mapped Postgres codes  → their status
 *  - anything else                      → 500 (logged)
 */
// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, _next) {
  if (res.headersSent) return;
  if (err instanceof ZodError) return res.status(400).json(validationBody(err));
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  if (err?.status >= 400 && err.status < 500) {
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : err.type === 'entity.too.large' ? 'Request body too large'
      : err.expose ? err.message : 'Bad request';
    return res.status(err.status).json({ error: message });
  }
  const { status, message } = toHttpError(err, 'Internal server error');
  if (status >= 500) logger.error('Unhandled error', { error: err?.message, stack: err?.stack, path: req.path });
  return res.status(status).json({ error: message });
}
