import api from './client.js'

export const listBroadcasts    = ()     => api.get('/broadcasts').then((r) => r.data)
export const sendDelayBroadcast = (data) => api.post('/broadcasts/delay', data).then((r) => r.data)
export const sendBusyBroadcast  = (data) => api.post('/broadcasts/busy', data).then((r) => r.data)
export const sendCustomBroadcast = (data) => api.post('/broadcasts/custom', data).then((r) => r.data)
