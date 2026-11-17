import api from './client.js'
import { paged } from './adapt.js'
import { normaliseLifecycle } from './jobs.js'

const withLifecycle = (r) => ({ ...r.data, lifecycle: normaliseLifecycle(r.data?.lifecycle) })

export const listQuotations        = (params)     => api.get('/quotations', { params }).then(r => paged(r.data, 'quotations'))
export const getQuotation          = (id)         => api.get(`/quotations/${id}`).then(withLifecycle)
/** Staff start a quote (from a chat or the client page) → { quotation, lifecycle } */
export const createQuotation       = (data)       => api.post('/quotations', data).then(withLifecycle)
export const approveQuotation      = (id, lineItems) => api.post(`/quotations/${id}/approve`, { lineItems }).then(withLifecycle)
/** Mark accepted / declined ('rejected') / revise ('draft') → { quotation, lifecycle } */
export const updateQuotationStatus = (id, status) => api.patch(`/quotations/${id}/status`, { status }).then(withLifecycle)
export const resendQuotation       = (id)         => api.post(`/quotations/${id}/resend`).then(r => r.data)
export const claimQuotation        = (id)         => api.post(`/quotations/${id}/claim`).then(r => r.data)

/** Autosave a draft (still being priced): { lineItems?, notes?, validUntil? } → { quotation }; 409 QUOTE_NOT_DRAFT once sent */
export const saveQuotationDraft    = (id, data)   => api.put(`/quotations/${id}`, data).then(r => r.data)

/**
 * The quote PDF as a Blob — fetched with the staff token, so a draft (not yet
 * public) can be previewed before it is sent.
 */
export const fetchQuotationPdf = (id) =>
  api.get(`/quotations/${id}/pdf`, { responseType: 'blob' })
    .then(r => r.data)
    .catch(async (err) => {
      const body = err.response?.data
      if (body instanceof Blob) {
        try { err.response.data = JSON.parse(await body.text()) } catch { /* not JSON */ }
      }
      throw err
    })
