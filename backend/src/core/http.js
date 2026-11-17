import { validationBody, isUuid } from './errors.js';

/** Wrap an async route handler so a rejection reaches the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  try {
    return Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    return next(err);
  }
};

/**
 * Validate request parts with zod schemas; parsed values land on req.valid.
 * validate({ body: Schema, query: Schema, params: Schema })
 */
export function validate(schemas) {
  return (req, res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const parsed = schema.safeParse(req[part] ?? {});
      if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
      req.valid[part] = parsed.data;
    }
    return next();
  };
}

/** router.param() handler that rejects non-UUID ids with 400 `Invalid <label> id`. */
export const uuidParam = (label) => (req, res, next, id) =>
  isUuid(id) ? next() : res.status(400).json({ error: `Invalid ${label} id` });

/**
 * Paginated list response: { items, total, page, limit } plus the legacy key the
 * frontend still reads (e.g. 'orders') until it switches to `items`.
 */
export function paged(res, legacyKey, { items, total, page, limit }) {
  const body = { items, total, page, limit };
  if (legacyKey) body[legacyKey] = items;
  return res.json(body);
}
