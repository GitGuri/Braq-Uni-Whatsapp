/**
 * Client profile validators — pure functions, no DB calls, no side effects.
 * Uses snake_case field names matching the clients table columns.
 *
 * Two validators:
 *   validateClientProfile  — minimum profile completeness (name + type + org/school)
 *   validateClientForOrder — everything above + delivery preference required
 */

const ORG_REQUIRED_TYPES = new Set(['school', 'corporate', 'church', 'government', 'hospitality', 'security', 'reseller']);

/**
 * @param {object} client — row from the clients table (or partial object)
 * @returns {{ complete: boolean, missing: string[] }}
 */
export function validateClientProfile(client) {
  const missing = [];

  if (!client.name?.trim()) {
    missing.push('name');
  }

  if (!client.client_type) {
    missing.push('client_type');
  }

  if (client.client_type && ORG_REQUIRED_TYPES.has(client.client_type)) {
    const hasOrg    = !!client.organisation?.trim();
    const hasSchool = !!client.school_name?.trim();
    if (!hasOrg && !hasSchool) {
      missing.push('organisation or school_name (required for this client type)');
    }
  }

  return { complete: missing.length === 0, missing };
}

/**
 * Additional gate required before an order can be created.
 * Checks everything in validateClientProfile PLUS delivery/collection preference.
 *
 * Delivery preference is derived from existing fields until Phase 5 adds the
 * dedicated delivery_preference column:
 *   preferred_store_location → client collects from a store
 *   physical_address         → client expects delivery to an address
 *   delivery_preference      → explicit new column (Phase 5 onwards)
 *
 * @param {object} client
 * @returns {{ complete: boolean, missing: string[] }}
 */
export function validateClientForOrder(client) {
  const base = validateClientProfile(client);
  const missing = [...base.missing];

  const hasDeliveryInfo = !!(
    client.delivery_preference?.trim()         ||
    client.preferred_store_location?.trim()    ||
    client.physical_address?.trim()
  );

  if (!hasDeliveryInfo) {
    missing.push(
      'delivery_preference — client must specify collection (store location) or delivery (physical address)'
    );
  }

  return { complete: missing.length === 0, missing };
}
