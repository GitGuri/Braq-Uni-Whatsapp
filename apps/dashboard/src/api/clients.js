import api from './client.js'

export const listClients = (params) =>
  api.get('/clients', { params }).then((r) => r.data)

export const getClient = (id) =>
  api.get(`/clients/${id}`).then((r) => r.data)

export const updateClient = (id, data) =>
  api.patch(`/clients/${id}`, data).then((r) => r.data)
