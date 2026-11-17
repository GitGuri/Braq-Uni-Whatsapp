import { validationBody, isUuid } from './errors.js';

/** Wrap an async route handler so a rejection reaches the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  try {
    return Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    return next(err);
  }
};

/** Wrap one (req, res, next) handler like asyncHandler, keeping its arity < 4 (not an error handler). */
function guardHandler(fn) {
  if (fn.length >= 4 || fn.__guarded) return fn;
  const guarded = function guarded(req, res, next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.then === 'function') out.then(undefined, next);
      return out;
    } catch (err) {
      return next(err);
    }
  };
  guarded.__guarded = true;
  return guarded;
}

/**
 * Safety net for a whole router (SEC-4): every route handler and router-level
 * middleware gets asyncHandler semantics, so a rejected promise or a synchronous
 * throw reaches the error middleware (500 + log) instead of becoming an
 * unhandled rejection, which on Node ≥ 15 terminates the API process.
 * Call after all routes are registered. Returns the router.
 */
export function catchAsyncRoutes(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const inner of layer.route.stack) inner.handle = guardHandler(inner.handle);
    } else if (layer.handle?.stack) {
      catchAsyncRoutes(layer.handle);               // nested router
    } else if (typeof layer.handle === 'function') {
      layer.handle = guardHandler(layer.handle);
    }
  }
  return router;
}

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
