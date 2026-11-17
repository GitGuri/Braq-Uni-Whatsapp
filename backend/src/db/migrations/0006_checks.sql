-- 0006 CHECK constraints on the plain-text status columns of orders.
-- Allowed values = the canonical sets plus every legacy value older rows may
-- carry (rows are never rewritten). Each constraint is added NOT VALID (no long
-- lock) and then validated (SHARE UPDATE EXCLUSIVE — does not block writes),
-- but only when no row violates it: a NOT VALID constraint would still reject
-- any UPDATE of a violating row. When violating rows exist a NOTICE is raised
-- and the constraint is skipped; clean the rows up and add it in a later migration.
DO $$
DECLARE
  stages   text[] := ARRAY[
    'deposit_pending', 'in_production', 'ready', 'completed',
    -- legacy 10-stage pipeline values and the old cancelled stage
    'quotation_requested', 'quotation_submitted', 'po_received', 'purchase_order_received',
    'design_approval_pending', 'materials_procurement', 'production_scheduled', 'manufacturing',
    'branding_embroidery', 'quality_control', 'packing_dispatch', 'cancelled'];
  payments text[] := ARRAY['unpaid', 'deposit_paid', 'paid_in_full', 'deposit_required', 'not_required'];
  proofs   text[] := ARRAY['none', 'sent', 'approved', 'revision_requested'];
  bad bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_stage_check') THEN
    SELECT COUNT(*) INTO bad FROM orders WHERE stage <> ALL (stages);
    IF bad = 0 THEN
      EXECUTE format('ALTER TABLE orders ADD CONSTRAINT orders_stage_check CHECK (stage = ANY (%L::text[])) NOT VALID', stages);
      ALTER TABLE orders VALIDATE CONSTRAINT orders_stage_check;
    ELSE
      RAISE NOTICE 'orders_stage_check skipped: % order(s) have an unknown stage', bad;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_status_check') THEN
    SELECT COUNT(*) INTO bad FROM orders WHERE payment_status <> ALL (payments);
    IF bad = 0 THEN
      EXECUTE format('ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status = ANY (%L::text[])) NOT VALID', payments);
      ALTER TABLE orders VALIDATE CONSTRAINT orders_payment_status_check;
    ELSE
      RAISE NOTICE 'orders_payment_status_check skipped: % order(s) have an unknown payment_status', bad;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_proof_status_check') THEN
    SELECT COUNT(*) INTO bad FROM orders WHERE proof_status <> ALL (proofs);
    IF bad = 0 THEN
      EXECUTE format('ALTER TABLE orders ADD CONSTRAINT orders_proof_status_check CHECK (proof_status = ANY (%L::text[])) NOT VALID', proofs);
      ALTER TABLE orders VALIDATE CONSTRAINT orders_proof_status_check;
    ELSE
      RAISE NOTICE 'orders_proof_status_check skipped: % order(s) have an unknown proof_status', bad;
    END IF;
  END IF;
END $$;
