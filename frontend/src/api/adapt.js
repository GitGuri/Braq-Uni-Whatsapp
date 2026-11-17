/**
 * Response adapters — the one place API envelopes are unwrapped, so a contract
 * change only needs fixing here.
 */

/**
 * Rows of a list response. New endpoints send { items, total, page, limit };
 * older ones (kept for one release) send their legacy key ({ orders }, { tickets } …)
 * or a bare array.
 */
export function listItems(data, legacyKey) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  if (legacyKey && Array.isArray(data?.[legacyKey])) return data[legacyKey]
  return []
}

/** { items, total, page, limit } for any list response (total null when the API sent none). */
export function paged(data, legacyKey) {
  const items = listItems(data, legacyKey)
  const total = data?.total != null && Number.isFinite(Number(data.total)) ? Number(data.total) : null
  return {
    items,
    total,
    page: data?.page != null ? Number(data.page) : null,
    limit: data?.limit != null ? Number(data.limit) : null,
    counts: data?.counts ?? null,
  }
}

/**
 * A lifecycle guard refusal (409 { error, code, overridable }) or any other
 * action failure, as something the UI can explain inline instead of toasting.
 * @returns {{ status: number|null, code: string|null, message: string, overridable: boolean, reasons: string[], blockers: object[] }}
 */
export function actionError(err, fallback = 'That did not work. Try again.') {
  const status = err?.response?.status ?? null
  const body = err?.response?.data ?? {}
  let message = typeof body.error === 'string' && body.error.trim() ? body.error : null
  if (!message && body.error && typeof body.error === 'object') {
    const parts = [
      ...(Array.isArray(body.error.formErrors) ? body.error.formErrors : []),
      ...Object.entries(body.error.fieldErrors ?? {}).flatMap(([k, v]) => [v].flat().filter(Boolean).map((m) => `${k}: ${m}`)),
    ]
    if (parts.length) message = parts.join('; ')
  }
  if (!message && !err?.response && err?.message) message = err.message
  return {
    status,
    code: typeof body.code === 'string' ? body.code : null,
    message: message || fallback,
    overridable: body.overridable === true,
    reasons: Array.isArray(body.reasons) ? body.reasons.map(String) : [],
    // Every check that blocks a step: [{ code, message, overridable }] (409 from /orders/:id/advance)
    blockers: Array.isArray(body.blockers) ? body.blockers.filter((b) => b && b.message) : [],
  }
}
