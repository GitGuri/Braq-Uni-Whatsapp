import api from './client.js'

export const listOrders = (params) =>
  api.get('/orders', { params }).then((r) => r.data)

export const getOrder = (id) =>
  api.get(`/orders/${id}`).then((r) => r.data)

export const createOrder = (data) =>
  api.post('/orders', data).then((r) => r.data)

export const advanceStage = (id, data) =>
  api.post(`/orders/${id}/advance`, data).then((r) => r.data)

export const delayOrder = (id, data) =>
  api.post(`/orders/${id}/delay`, data).then((r) => r.data)

export const assignOrder = (id, staffId) =>
  api.patch(`/orders/${id}/assign`, { staffId }).then((r) => r.data)

export const recordPayment = (id, data) =>
  api.post(`/orders/${id}/payments`, data).then((r) => r.data)

export const listPayments = (id) =>
  api.get(`/orders/${id}/payments`).then((r) => r.data)

export const listSizes = (id) =>
  api.get(`/orders/${id}/sizes`).then((r) => r.data)

export const uploadSizes = (id, file) => {
  const form = new FormData()
  form.append('file', file)
  return api
    .post(`/orders/${id}/sizes/upload`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data)
}
