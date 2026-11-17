import api from './client.js'
import { paged } from './adapt.js'

export const listPurchaseOrders = (params) =>
  api.get('/purchase-orders', { params }).then((r) => paged(r.data, 'purchaseOrders'))

/** { quotationId, poNumber, amount?, notes? } → 201 { purchaseOrder, order, warnings } | 422 { error, reasons } */
export const createPurchaseOrder = (data) =>
  api.post('/purchase-orders', data).then((r) => r.data)
