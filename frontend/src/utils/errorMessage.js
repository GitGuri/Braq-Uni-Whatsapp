/**
 * Turn an axios/API error into a human-readable string that is always safe to
 * render as a React child.
 *
 * Handles the backend's `{ error: string, details? }` shape as well as the legacy
 * `{ error: { formErrors, fieldErrors } }` (zod flatten) shape and plain Errors.
 */

export const NO_RESPONSE_MUTATION = 'No response from the server — the action may have gone through. Refresh before trying again.'
export const NO_RESPONSE_READ = 'No response from the server. Check your connection and try again.'
export const SERVICE_UNAVAILABLE = 'Service temporarily unavailable — try again in a moment'

/**
 * Transport-level failures, worded for people instead of "timeout of 30000ms exceeded":
 *   - no response at all (timeout, network down): for a change (POST/PUT/PATCH/DELETE)
 *     the server may still have done it, so say so;
 *   - 503: the server is up but its database is briefly unreachable.
 * Anything else → null (use the server's own message).
 */
export function transportMessage(err) {
  if (!err || typeof err !== 'object') return null
  const isHttp = err.isAxiosError === true || !!err.config
  if (!isHttp || err.code === 'ERR_CANCELED') return null
  if (err.response?.status === 503) return SERVICE_UNAVAILABLE
  if (!err.response && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ERR_NETWORK' || err.request)) {
    const method = String(err.config?.method ?? 'get').toLowerCase()
    return ['get', 'head', 'options'].includes(method) ? NO_RESPONSE_READ : NO_RESPONSE_MUTATION
  }
  return null
}

export function errorMessage(err, fallback = 'Something went wrong') {
  const transport = transportMessage(err)
  if (transport) return transport
  const e = err?.response?.data?.error
  if (typeof e === 'string' && e.trim()) return e
  if (e && typeof e === 'object') {
    const form = Array.isArray(e.formErrors) ? e.formErrors : []
    const fields = e.fieldErrors && typeof e.fieldErrors === 'object'
      ? Object.entries(e.fieldErrors).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter(Boolean).map((m) => `${k}: ${m}`))
      : []
    const parts = [...form, ...fields].filter((x) => typeof x === 'string' && x)
    if (parts.length) return parts.join('; ')
    if (typeof e.message === 'string' && e.message) return e.message
  }
  if (!err?.response && typeof err?.message === 'string' && err.message) return err.message
  return fallback
}

export default errorMessage
