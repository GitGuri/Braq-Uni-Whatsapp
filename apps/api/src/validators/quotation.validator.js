/**
 * Quotation validator — pure function, no DB calls, no side effects.
 *
 * A quotation is COMPLETE when every line item has:
 *   • description or name
 *   • quantity > 0
 *   • sizes (array or string)
 *   • branding (boolean — yes/no with detail)
 *   • productId (matched to catalog)
 *
 * If ANY item lacks a productId (unmatched), the quotation CANNOT be
 * auto-sent as a PDF. It must save as status='draft' and route to
 * awaiting_consultant instead.
 *
 * @param {object} quotation
 * @param {Array}  quotation.line_items
 * @returns {{
 *   complete: boolean,
 *   missing: string[],
 *   warnings: string[],
 *   lineItemIssues: Array<{ index: number, label: string, issues: string[] }>,
 *   hasUnmatched: boolean,
 * }}
 */
export function validateQuotation(quotation) {
  const missing      = [];
  const warnings     = [];
  const lineItemIssues = [];

  const items = quotation.line_items ?? [];

  if (!Array.isArray(items) || items.length === 0) {
    missing.push('at least one line item');
    return { complete: false, missing, warnings, lineItemIssues, hasUnmatched: false };
  }

  let hasUnmatched = false;

  for (let i = 0; i < items.length; i++) {
    const item   = items[i];
    const issues = [];
    const label  = item.name || item.description || `Item ${i + 1}`;

    // Required: something to identify the item
    if (!item.description?.trim() && !item.name?.trim()) {
      issues.push('description/name');
    }

    // Required: positive quantity
    if (!item.quantity || Number(item.quantity) <= 0) {
      issues.push('quantity');
    }

    // Required: sizes (array with entries, or non-empty string)
    const hasSizes =
      (Array.isArray(item.sizes) && item.sizes.length > 0) ||
      (typeof item.sizes === 'string' && item.sizes.trim().length > 0) ||
      (typeof item.size  === 'string' && item.size.trim().length  > 0);
    if (!hasSizes) {
      issues.push('sizes');
    }

    // Required: branding decision (explicit true/false, or string 'yes'/'no')
    const brandingProvided =
      item.branding === true  || item.branding === false ||
      item.branding === 'yes' || item.branding === 'no'  ||
      (typeof item.branding === 'string' && item.branding.trim().length > 0);
    if (!brandingProvided) {
      issues.push('branding (yes/no — and detail if yes)');
    }

    // Unmatched: item has no catalog productId — can never be auto-priced
    if (!item.productId) {
      hasUnmatched = true;
      issues.push('product catalog match (unrecognised item — needs manual pricing)');
    }

    if (issues.length > 0) {
      lineItemIssues.push({ index: i, label, issues });
    }
  }

  // Accumulate per-item issues into the top-level missing array
  for (const li of lineItemIssues) {
    for (const issue of li.issues) {
      missing.push(`"${li.label}": ${issue}`);
    }
  }

  if (hasUnmatched) {
    warnings.push(
      'One or more items could not be matched to the product catalog. ' +
      'The quotation will be saved as draft and assigned to a consultant for manual pricing.'
    );
  }

  // complete only if zero missing fields AND zero unmatched items
  const complete = missing.length === 0 && !hasUnmatched;

  return { complete, missing, warnings, lineItemIssues, hasUnmatched };
}
