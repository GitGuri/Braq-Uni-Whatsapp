-- 0013 unanswered-chat reminder (audit MSG-2). Additive and idempotent.
-- While a consultant owns a chat (consultant_active) the bot stays silent, so a
-- forgotten chat leaves the client unanswered indefinitely. reminder.scan emails the
-- owner when the client's latest message has waited 2 hours; this stamp records the
-- last such reminder so each unanswered message is reminded about once.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unanswered_reminder_at TIMESTAMPTZ;
