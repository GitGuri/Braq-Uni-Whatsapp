import api from './client.js'

export const login = (email, password) =>
  api.post('/staff/login', { email, password }).then((r) => r.data)

export const me = () => api.get('/staff/me').then((r) => r.data)

export const listStaff = () => api.get('/staff').then((r) => r.data)

export const createStaff = (data) => api.post('/staff', data).then((r) => r.data)
