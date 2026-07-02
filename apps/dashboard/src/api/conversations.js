import api from './client.js'

export const listConversations = (params) =>
  api.get('/conversations', { params }).then((r) => r.data)

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
