import api from './client.js'
import { paged } from './adapt.js'

/** A lifecycle object as the UI expects it, whatever the endpoint sent. */
export function normaliseLifecycle(lc) {
  if (!lc || typeof lc !== 'object') return { state: null, label: null, flags: [], nextActions: [] }
  return {
    state: lc.state ?? null,
    label: lc.label ?? null,
    flags: Array.isArray(lc.flags) ? lc.flags : [],
    nextActions: Array.isArray(lc.nextActions) ? lc.nextActions : [],
  }
}

/**
 * GET /jobs — the board.
 * params: { state?: 'PRICING' | 'PRICING,QUOTED', queue?: 'accepted' | …, owner?: 'me'|'unassigned', overdue?: 'true',
 *           search?, clientId?, page?, limit? }
 * → { items, total, page, limit, counts: { STATE: n }, queueCounts: { queue: n }, flagCounts: { FLAG: n } }
 *   items carry `queue` and `primary_action` ({ key, label, endpoint } when the next step is one click, else null).
 */
export const listJobs = (params = {}) =>
  api.get('/jobs', { params }).then((r) => {
    const p = paged(r.data, 'jobs')
    return { ...p, counts: p.counts ?? {}, queueCounts: r.data?.queueCounts ?? {}, flagCounts: r.data?.flagCounts ?? {} }
  })

/**
 * Run a lifecycle action endpoint as the API described it ({ method, path, body? }; path starts with /api),
 * e.g. a dashboard row's one-click primary action.
 */
export const runActionEndpoint = (endpoint, extra = {}) =>
  api.request({
    method: endpoint.method,
    url: String(endpoint.path).replace(/^\/api(?=\/)/, ''),
    data: { ...(endpoint.body ?? {}), ...extra },
  }).then((r) => r.data)

/** GET /jobs/:quotationId — everything about one job. */
export const getJob = (quotationId) =>
  api.get(`/jobs/${quotationId}`).then((r) => {
    const d = r.data ?? {}
    return {
      quotation:      d.quotation ?? null,
      order:          d.order ?? null,
      payments:       d.payments ?? [],
      sizes:          d.sizes ?? [],
      purchaseOrders: d.purchaseOrders ?? [],
      tickets:        d.tickets ?? [],
      conversation:   d.conversation ?? null,
      client:         d.client ?? null,
      history:        d.history ?? [],
      lifecycle:      normaliseLifecycle(d.lifecycle),
    }
  })

/** GET /jobs/by-order/:orderId → { orderId, quotationId } (quotationId null for a legacy order). */
export const jobForOrder = (orderId) =>
  api.get(`/jobs/by-order/${orderId}`).then((r) => ({
    orderId: r.data?.orderId ?? orderId,
    quotationId: r.data?.quotationId ?? r.data?.quotation_id ?? null,
  }))
