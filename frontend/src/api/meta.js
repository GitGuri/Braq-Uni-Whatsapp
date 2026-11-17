import api from './client.js'

/** GET /meta — lifecycle vocabulary, business numbers and the caller's permissions. */
export const getMeta = () => api.get('/meta').then((r) => r.data ?? {})
