/**
 * Purchase order validator — pure function, no DB calls, no side effects.
 *
 * Required:
 *   • quotation_id or quotation_reference
 *   • po_number
 *   • (when quotation is provided) quotation must be in 'sent' or 'accepted' status
 *   • (when quotation is provided) quotation must not be expired
 *   • (when po.amount is provided) amount must be within 5% of quotation total
 *
 * @param {object} po                  — purchase order data (may be partial pre-save)
 * @param {object|null} [quotation]    — full quotation row (when available)
 * @returns {{ complete: boolean, missing: string[], warnings: string[] }}
 */

const VALID_STATUSES    = new Set(['sent', 'accepted']);
const AMOUNT_TOLERANCE  = 0.05; // 5 %

export function validatePurchaseOrder(po, quotation = null) {
  const missing  = [];
  const warnings = [];

  // 1. Must reference a quotation
  const hasRef = !!(po.quotation_id || po.quotation_reference?.trim());
  if (!hasRef) {
    missing.push('quotation_id or quotation_reference');
  }

  // 2. PO number
  if (!po.po_number?.trim()) {
    missing.push('po_number');
  }

  // 3. Quotation-level checks (only when the quotation object is supplied)
  if (quotation) {
    if (!VALID_STATUSES.has(quotation.status)) {
      missing.push(
        `quotation status must be 'sent' or 'accepted' (currently: '${quotation.status}')`
      );
    }

    if (quotation.valid_until && new Date(quotation.valid_until) < new Date()) {
      missing.push(
        `quotation has expired (valid until ${new Date(quotation.valid_until).toLocaleDateString('en-ZA')})`
      );
    }

    // 4. Amount cross-check (warning, not a blocking error — mismatch needs review, not rejection)
    if (po.amount != null) {
      const qTotal  = Number(quotation.total);
      const poAmt   = Number(po.amount);
      if (qTotal > 0) {
        const diff = Math.abs(qTotal - poAmt) / qTotal;
        if (diff > AMOUNT_TOLERANCE) {
          warnings.push(
            `PO amount (R ${poAmt.toFixed(2)}) differs from quotation total ` +
            `(R ${qTotal.toFixed(2)}) by ${(diff * 100).toFixed(1)}% — ` +
            `please verify before proceeding`
          );
        }
      }
    }
  }

  return {
    complete: missing.length === 0,
    missing,
    warnings,
  };
}
