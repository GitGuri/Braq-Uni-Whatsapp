import api from './client.js'

export const listProducts = (params) =>
  api.get('/products', { params }).then((r) => r.data)

export const getProduct = (id) =>
  api.get(`/products/${id}`).then((r) => r.data)

export const createProduct = (data) =>
  api.post('/products', data).then((r) => r.data)

export const updateProduct = (id, data) =>
  api.patch(`/products/${id}`, data).then((r) => r.data)
