import api from './client.js'
import { paged } from './adapt.js'

export const listTickets  = (params) => api.get('/tickets', { params }).then((r) => paged(r.data, 'tickets'))
export const getTicket    = (id)     => api.get(`/tickets/${id}`).then((r) => r.data)
/** { clientId, orderId?, category, description } → { ticket } */
export const createTicket = (data)   => api.post('/tickets', data).then((r) => r.data)
/** { status?, assignedStaffId? (null clears), resolutionNote? } */
export const updateTicket = (id, data) => api.patch(`/tickets/${id}`, data).then((r) => r.data)
export const claimTicket  = (id)     => api.post(`/tickets/${id}/claim`).then((r) => r.data)
