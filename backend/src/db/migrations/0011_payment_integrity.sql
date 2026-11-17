-- 0011 payment integrity (audit FIN-1). Additive and idempotent; no existing row is changed.

-- Who recorded the payment (staff can be removed later: keep the payment, drop the link).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by UUID REFERENCES staff(id) ON DELETE SET NULL;

-- Client-generated key per "Record payment" submission: a retried or double-submitted
-- request carries the same key and returns the first payment instead of storing a second.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Existing rows have no key (NULL), so the partial index cannot conflict with them.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_payments_order_idempotency
  ON payments (order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A payment is always a positive amount. NOT VALID: enforced for every new or updated
-- row at once without scanning (or failing on) historical rows; validated below only
-- when the existing data already satisfies it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_positive') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE amount <= 0) THEN
    ALTER TABLE payments VALIDATE CONSTRAINT payments_amount_positive;
  ELSE
    RAISE NOTICE 'payments_amount_positive left NOT VALID: % historical row(s) have amount <= 0',
      (SELECT COUNT(*) FROM payments WHERE amount <= 0);
  END IF;
END $$;
