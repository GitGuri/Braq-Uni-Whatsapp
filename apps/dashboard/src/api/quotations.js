import api from './client.js'

export const listQuotations = (params) =>
  api.get('/quotations', { params }).then((r) => r.data)

export const getQuotation = (id) =>
  api.get(`/quotations/${id}`).then((r) => r.data)

export const approveQuotation = (id, lineItems) =>
  api.post(`/quotations/${id}/approve`, { lineItems }).then((r) => r.data)

export const getPdfUrl = (id) =>
  `${import.meta.env.VITE_API_BASE_URL ?? '/api'}/quotations/${id}/pdf`
