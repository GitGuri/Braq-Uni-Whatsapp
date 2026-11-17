import api from './client.js'

export const login = (email, password) =>
  api.post('/staff/login', { email, password }).then((r) => r.data)

export const me = () => api.get('/staff/me').then((r) => r.data)

/** → { staff: [{ id, name, email, role, is_active, created_at }] } — includes people whose access was removed. */
export const listStaff = () => api.get('/staff').then((r) => r.data)

export const createStaff = (data) => api.post('/staff', data).then((r) => r.data)

/** Remove access (the account is deactivated; past work keeps the name). 400 SELF / 409 LAST_ADMIN. */
export const deleteStaff = (id) => api.delete(`/staff/${id}`).then((r) => r.data)

/** PATCH /staff/:id (admin) — data: { role?, isActive?, password? } → { staff } */
export const updateStaff = (id, data) => api.patch(`/staff/${id}`, data).then((r) => r.data)

/**
 * Staff who can be given work: people with access, plus `keepId` (whoever is
 * assigned now) so a current owner whose access was removed still shows by name.
 */
export const assignableStaff = (staff = [], keepId = null) =>
  staff.filter((s) => s.is_active !== false || (keepId && s.id === keepId))
