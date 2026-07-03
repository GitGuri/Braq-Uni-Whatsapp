/**
 * Order validator — pure function, no DB calls, no side effects.
 *
 * Guards the stage-advance gate at quotation_submitted → purchase_order_received.
 * After that transition ALL subsequent advances are permitted without re-running
 * this check (sizing/payment issues are consultant-managed from that point on).
 *
 * Required before advancing past quotation_submitted:
 *   1. Linked quotation OR manual line_items (at least one)
 *   2. Size roster: ≥ 1 entry per total units ordered — OR an explicit
 *      sizes_tbc_by date is set (a future ISO date string)
 *   3. payment_status must NOT be 'not_required' when a quotation is linked
 *      (deposit percentage must have been initialised)
 *   4. Delivery/collection preference present (order level or derived from client)
 *
 * @param {object} order         — row from the orders table
 * @param {object} [options]
 * @param {Array}  [options.sizeEntries]  — rows from order_size_entries
 * @param {object} [options.quotation]    — full quotation row (optional, in addition to order.quotation_id)
 * @param {object} [options.client]       — full client row (for delivery info fallback)
 * @returns {{ complete: boolean, missing: string[], canAdvance: boolean }}
 */

const STAGES_REQUIRING_VALIDATION = new Set([
  'purchase_order_received',
  'design_approval_pending',
  'materials_procurement',
  'production_scheduled',
  'manufacturing',
  'branding_embroidery',
  'quality_control',
  'packing_dispatch',
  'completed',
]);

export function validateOrder(order, { sizeEntries = [], quotation = null, client = null } = {}) {
  const missing = [];

  // Only enforce these constraints at the critical gate stage
  const isAtGate = order.stage === 'quotation_submitted' || STAGES_REQUIRING_VALIDATION.has(order.stage);
  if (!isAtGate) {
    return { complete: true, missing: [], canAdvance: true };
  }

  // 1. Must have a quotation or manual line items
  const hasQuotation  = !!(quotation || order.quotation_id);
  const hasLineItems  = Array.isArray(order.line_items) && order.line_items.length > 0;
  if (!hasQuotation && !hasLineItems) {
    missing.push('linked quotation or manually entered line items');
  }

  // 2. Sizing list
  const totalQty =
    (quotation?.line_items ?? []).reduce((s, i) => s + (Number(i.quantity) || 0), 0) ||
    Number(order.quantity) ||
    0;

  const sizesTbcSet =
    order.sizes_tbc_by &&
    new Date(order.sizes_tbc_by) > new Date();

  if (totalQty > 0 && sizeEntries.length === 0 && !sizesTbcSet) {
    missing.push(
      `size roster — ${totalQty} unit(s) ordered but no sizing list uploaded ` +
      `(upload a .xlsx/.csv roster, or set a "sizes confirmed by" date)`
    );
  }

  // 3. Payment status must be initialised when a quotation is linked
  if (hasQuotation && order.payment_status === 'not_required') {
    missing.push(
      `payment_status — must be initialised (set deposit percentage) now that a quotation is linked`
    );
  }

  // 4. Delivery/collection info — check order first, fall back to client
  const hasDelivery = !!(
    order.delivery_type                        ||
    order.tracking_number                      ||
    client?.preferred_store_location?.trim()   ||
    client?.physical_address?.trim()           ||
    client?.delivery_preference?.trim()
  );
  if (!hasDelivery) {
    missing.push(
      'delivery/collection preference — client must have a preferred store location or physical address on file'
    );
  }

  return {
    complete:    missing.length === 0,
    missing,
    canAdvance:  missing.length === 0,
  };
}
