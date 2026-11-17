-- 0009 staff dashboard round 2. Additive and idempotent.
--
--  1. Account clients: admins / managers may mark a client as trading on
--     account terms (no deposit needed before production). Who and when is kept.
--  2. messages.sent_by_staff_id: which staff member wrote an outbound message
--     (NULL = sent by the bot / the system), so the inbox can say "Bot:" or "You:".
--  3. Legacy orders without a quotation get a linked, accepted quotation so every
--     order is a job on the Jobs board (reference 'BRQ-Q-LEGACY-' || order ref).

-- 1. Account terms ------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_terms        BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_terms_set_by UUID        REFERENCES staff(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_terms_set_at TIMESTAMPTZ;

-- 2. Who sent an outbound message ---------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;

-- 3. Legacy orders into Jobs --------------------------------------------------
-- 'BRQ-Q-LEGACY-' + an order reference can exceed the old 30 characters.
-- Widening a VARCHAR is a catalogue-only change (no table rewrite).
DO $$ BEGIN
  IF (SELECT character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'quotations' AND column_name = 'reference') < 60 THEN
    ALTER TABLE quotations ALTER COLUMN reference TYPE VARCHAR(60);
  END IF;
END $$;

-- Totals: the order's own total, else deposit + balance; VAT (15%) derived from
-- the VAT-inclusive total. Line items are unknown for these orders.
INSERT INTO quotations
  (reference, client_id, status, line_items, subtotal, vat, total, currency, notes,
   assigned_staff_id, conversation_id, created_at, updated_at)
SELECT 'BRQ-Q-LEGACY-' || o.reference,
       o.client_id,
       'accepted',
       '[]'::jsonb,
       ROUND(t.total / 1.15, 2),
       t.total - ROUND(t.total / 1.15, 2),
       t.total,
       'ZAR',
       'Created automatically for an order placed before quotes were linked',
       o.assigned_staff_id,
       o.conversation_id,
       o.created_at,
       o.created_at
FROM orders o
CROSS JOIN LATERAL (
  SELECT COALESCE(o.total_amount, COALESCE(o.deposit_amount, 0) + COALESCE(o.balance_amount, 0), 0)::numeric(12,2) AS total
) t
WHERE o.quotation_id IS NULL
ON CONFLICT (reference) DO NOTHING;

UPDATE orders o
SET quotation_id = q.id
FROM quotations q
WHERE o.quotation_id IS NULL
  AND q.reference = 'BRQ-Q-LEGACY-' || o.reference
  AND q.client_id = o.client_id
  AND NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.quotation_id = q.id);
