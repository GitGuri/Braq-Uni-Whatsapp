import api from './client.js'
import { paged } from './adapt.js'
import { normaliseLifecycle } from './jobs.js'

export const getKpis        = ()       => api.get('/orders/kpis').then(r => r.data)
export const listOrders     = (params) => api.get('/orders', { params }).then(r => paged(r.data, 'orders'))
export const getOrder       = (id)     => api.get(`/orders/${id}`).then(r => ({ ...r.data, lifecycle: normaliseLifecycle(r.data?.lifecycle) }))
/** { clientId, quotationId (accepted) | lineItems, clientType?, poNumber?, assignedStaffId?, conversationId? } */
export const createOrder    = (data)   => api.post('/orders', data).then(r => r.data)
/**
 * Move an order on. data: { notes?, estimatedCompletion?, trackingNumber?, deliveryType?, override?: { reason } }
 * A blocked step answers 409 { error, code, overridable } — see api/adapt.js actionError().
 */
export const advanceStage   = (id, data) => api.post(`/orders/${id}/advance`, data).then(r => r.data)
export const setHold        = (id, data) => api.patch(`/orders/${id}/hold`, data).then(r => r.data)
export const assignOrder    = (id, staffId) => api.patch(`/orders/${id}/assign`, { staffId }).then(r => r.data)
export const recordPayment  = (id, data) => api.post(`/orders/${id}/payments`, data).then(r => r.data)
export const listPayments   = (id)     => api.get(`/orders/${id}/payments`).then(r => r.data)

export const convertFromQuotation = (quotationId, data) =>
  api.post(`/orders/convert-from-quotation/${quotationId}`, data).then(r => r.data)

export const updateMaterials  = (id, data) => api.patch(`/orders/${id}/materials`, data).then(r => r.data)
export const sendProof        = (id, data) => api.post(`/orders/${id}/proof`, data).then(r => r.data)
export const updateProofStatus = (id, data) => api.patch(`/orders/${id}/proof/status`, data).then(r => r.data)

/** Size roster: .xlsx / .csv with Name, Size[, Notes] columns. Replaces the existing roster → { sizes, count } */
export const uploadSizes = (id, file) => {
  const form = new FormData()
  form.append('file', file)
  return api.post(`/orders/${id}/sizes/upload`, form).then(r => r.data)
}
export const listSizes = (id) => api.get(`/orders/${id}/sizes`).then(r => r.data?.sizes ?? [])

// The sheet sits behind requireAuth, so it must be fetched with the Bearer header
// (a plain <a href> would 401). Resolves to a PDF Blob.
export const downloadSizeRunSheet = (id) =>
  api.get(`/orders/${id}/size-run-sheet`, { responseType: 'blob' })
    .then(r => r.data)
    .catch(async (err) => {
      // Error bodies arrive as a Blob too — decode the JSON so errorMessage() can read it.
      const body = err.response?.data
      if (body instanceof Blob) {
        try { err.response.data = JSON.parse(await body.text()) } catch { /* not JSON */ }
      }
      throw err
    })
