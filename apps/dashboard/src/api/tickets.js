import api from './client.js'

export const listTickets  = (params) => api.get('/tickets', { params }).then((r) => r.data)
export const getTicket    = (id)     => api.get(`/tickets/${id}`).then((r) => r.data)
export const updateTicket = (id, data) => api.patch(`/tickets/${id}`, data).then((r) => r.data)
export const claimTicket  = (id)     => api.post(`/tickets/${id}/claim`).then((r) => r.data)
