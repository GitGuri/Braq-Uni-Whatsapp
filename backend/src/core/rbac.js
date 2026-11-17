/**
 * Role-based permissions — the single map of who may do what.
 * Routes use requirePermission(perm) (after requireAuth); services/policies
 * use can(staff, perm). GET /api/meta will expose the caller's permissions.
 */
export const PERMISSIONS = Object.freeze({
  'order.override': ['admin', 'manager'],
  'broadcast.send': ['admin', 'manager'],
  'staff.manage':   ['admin'],
  'analytics.view': ['admin', 'manager'],
  'settings.read':  ['admin', 'manager'],
  'settings.write': ['admin', 'manager'],
  'product.write':  ['admin', 'manager'],
  'po.create':      ['admin', 'manager'],
  'catalog.write':  ['admin', 'manager'],
  // Mark a client as trading on account terms (no deposit before production)
  'client.terms':   ['admin', 'manager'],
});

export const ROLES = ['admin', 'manager', 'consultant'];

/** True when the staff member's role grants the permission (unknown permissions → false). */
export function can(staff, perm) {
  const roles = PERMISSIONS[perm];
  return Boolean(roles && staff?.role && roles.includes(staff.role));
}

/** Every permission the staff member holds. */
export const permissionsFor = (staff) => Object.keys(PERMISSIONS).filter((p) => can(staff, p));

/** Express middleware: 403 unless req.staff holds the permission. */
export function requirePermission(perm) {
  if (!PERMISSIONS[perm]) throw new Error(`Unknown permission: ${perm}`);
  return (req, res, next) => {
    if (!can(req.staff, perm)) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}
