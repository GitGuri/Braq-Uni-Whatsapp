-- 0010 customer-side WhatsApp bot (UX round 2). Additive and idempotent.

-- Photos / documents a client sends while reporting a problem are linked to the ticket
-- (the placeholder message stays in the conversation; staff see it on the ticket too).
-- No index: the column is sparse and read per ticket; building one would lock messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;

-- Meta media id of an inbound attachment (so staff tooling can fetch it later).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id TEXT;
