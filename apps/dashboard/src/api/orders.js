import api from './client.js'

export const getKpis        = ()       => api.get('/orders/kpis').then(r => r.data)
export const listOrders     = (params) => api.get('/orders', { params }).then(r => r.data)
export const getOrder       = (id)     => api.get(`/orders/${id}`).then(r => r.data)
export const createOrder    = (data)   => api.post('/orders', data).then(r => r.data)
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
export const getSizeRunSheet  = (id)       => `/api/orders/${id}/size-run-sheet`
