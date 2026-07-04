import api from './client.js'

export const listQuotations        = (params)     => api.get('/quotations', { params }).then(r => r.data)
export const getQuotation          = (id)         => api.get(`/quotations/${id}`).then(r => r.data)
export const approveQuotation      = (id, lineItems) => api.post(`/quotations/${id}/approve`, { lineItems }).then(r => r.data)
export const updateQuotationStatus = (id, status) => api.patch(`/quotations/${id}/status`, { status }).then(r => r.data)
export const claimQuotation        = (id)         => api.post(`/quotations/${id}/claim`).then(r => r.data)
