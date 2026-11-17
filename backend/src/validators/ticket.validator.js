/**
 * Ticket validator — pure function, no DB calls, no side effects.
 *
 * Required fields:
 *   • category — always required
 *   • order_id — required when category implies a product issue
 *     (wrong_item, defective, missing_item)
 *   • description — required; must answer both sub-questions:
 *       "What item?" and "What is wrong with it?"
 *     Enforced by minimum length — the bot collects these as two separate
 *     prompted responses that are concatenated before saving.
 *
 * @param {object} ticket
 * @returns {{ complete: boolean, missing: string[] }}
 */

const PRODUCT_ISSUE_CATEGORIES = new Set(['wrong_item', 'defective', 'missing_item']);

// Minimum character count to ensure the description has meaningful content.
// Two short sentences answering "what item" + "what's wrong" comfortably exceed this.
const MIN_DESCRIPTION_LENGTH = 30;

export function validateTicket(ticket) {
  const missing = [];

  if (!ticket.category) {
    missing.push('category');
  }

  if (ticket.category && PRODUCT_ISSUE_CATEGORIES.has(ticket.category) && !ticket.order_id) {
    missing.push(
      `order_id — required for category "${ticket.category}" ` +
      `(which item/order is affected?)`
    );
  }

  const description = ticket.description?.trim() ?? '';
  if (!description) {
    missing.push('description — describe what item is affected and what the problem is');
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    missing.push(
      `description is too brief (${description.length} chars) — ` +
      `please specify (1) which item and (2) what is wrong with it`
    );
  }

  return { complete: missing.length === 0, missing };
}
