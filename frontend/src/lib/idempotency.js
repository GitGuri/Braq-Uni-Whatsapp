/**
 * A fresh idempotency key for one form submission (POST /orders/:id/payments).
 * Reuse the same key when the same submission is retried; take a new one after
 * success or when the form is opened again.
 *
 * crypto.randomUUID needs a secure context (https / localhost); fall back to
 * getRandomValues so the dashboard still works when opened over plain http.
 */
export function newIdempotencyKey() {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
