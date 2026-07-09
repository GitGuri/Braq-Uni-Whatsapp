import api from './client.js'

export const getRevenueData  = () => api.get('/analytics/revenue').then(r => r.data)
export const getTopClients   = (limit = 10) => api.get('/analytics/top-clients', { params: { limit } }).then(r => r.data)
export const getTopProducts  = (limit = 10) => api.get('/analytics/top-products', { params: { limit } }).then(r => r.data)
