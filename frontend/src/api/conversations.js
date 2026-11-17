import api from './client.js'
import { paged } from './adapt.js'

/**
 * params: { state?, isOpen?: 'true'|'false'|'all', assignedToMe?: 'true', search?, clientId?, page?, limit? }
 * → { items, total, … }
 */
export const listConversations = (params) =>
  api.get('/conversations', { params }).then((r) => paged(r.data, 'conversations'))

export const getConversation = (id) =>
  api.get(`/conversations/${id}`).then((r) => r.data)

export const getUnreadCount = () =>
  api.get('/conversations/unread-count').then((r) => r.data)

export const replyToConversation = (id, body) =>
  api.post(`/conversations/${id}/reply`, { body }).then((r) => r.data)

export const takeoverConversation = (id) =>
  api.patch(`/conversations/${id}/takeover`).then((r) => r.data)

export const handbackConversation = (id) =>
  api.patch(`/conversations/${id}/handback`).then((r) => r.data)

export const closeConversation = (id) =>
  api.patch(`/conversations/${id}/close`).then((r) => r.data)

export const assignConversation = (id, staffId) =>
  api.patch(`/conversations/${id}/assign`, { staffId }).then((r) => r.data)

export const markConversationRead = (id) =>
  api.patch(`/conversations/${id}/read`).then((r) => r.data)

export const claimConversation = (id) =>
  api.post(`/conversations/${id}/claim`).then((r) => r.data)

/** The client's most relevant conversation (open first, then latest), or null. */
export async function conversationForClient(clientId) {
  const { items } = await listConversations({ clientId, isOpen: 'all', limit: 100 })
  return items.find((c) => c.client_id === clientId) ?? null
}
