/**
 * useCan() — permission checks from GET /api/meta (the caller's permissions).
 * Until meta has loaded (or if it fails) the role map below — a copy of
 * backend core/rbac.js PERMISSIONS — keeps nav and buttons sensible.
 * The backend enforces every permission regardless; this only shapes the UI.
 *
 *   const can = useCan()
 *   can('order.override')
 */
import { useCallback } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { useMeta } from './useMeta.js'

const ROLE_FALLBACK = {
  'order.override': ['admin', 'manager'],
  'broadcast.send': ['admin', 'manager'],
  'staff.manage':   ['admin'],
  'analytics.view': ['admin', 'manager'],
  'settings.read':  ['admin', 'manager'],
  'settings.write': ['admin', 'manager'],
  'product.write':  ['admin', 'manager'],
  'po.create':      ['admin', 'manager'],
  'catalog.write':  ['admin', 'manager'],
  'client.terms':   ['admin', 'manager'],
}

export function useCan() {
  const { staff } = useAuth() ?? {}
  const meta = useMeta()
  const perms = Array.isArray(meta.permissions) ? meta.permissions : null
  return useCallback((perm) => {
    if (perms) return perms.includes(perm)
    return Boolean(staff?.role && ROLE_FALLBACK[perm]?.includes(staff.role))
  }, [perms, staff?.role])
}

export default useCan
