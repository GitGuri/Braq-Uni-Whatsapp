import api from './client.js'
import { paged } from './adapt.js'

export const listClients = (params) =>
  api.get('/clients', { params }).then((r) => paged(r.data, 'clients'))

export const getClient = (id) =>
  api.get(`/clients/${id}`).then((r) => r.data)

export const updateClient = (id, data) =>
  api.patch(`/clients/${id}`, data).then((r) => r.data)

/** Account terms (admin / manager): { accountTerms: boolean } → { client } */
export const setAccountTerms = (id, accountTerms) =>
  api.patch(`/clients/${id}/account-terms`, { accountTerms }).then((r) => r.data)

/** The client's open chat, started when there is none → { conversation, created } */
export const openClientConversation = (id) =>
  api.post(`/clients/${id}/conversation`).then((r) => r.data)
