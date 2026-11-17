/**
 * Turn an axios/API error into a human-readable string that is always safe to
 * render as a React child.
 *
 * Handles the backend's `{ error: string, details? }` shape as well as the legacy
 * `{ error: { formErrors, fieldErrors } }` (zod flatten) shape and plain Errors.
 */
export function errorMessage(err, fallback = 'Something went wrong') {
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
