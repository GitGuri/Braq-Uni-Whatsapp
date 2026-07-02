import api from './client.js'

export const listPurchaseOrders = (params) =>
  api.get('/purchase-orders', { params }).then((r) => r.data)

export const createPurchaseOrder = (data) =>
  api.post('/purchase-orders', data).then((r) => r.data)
