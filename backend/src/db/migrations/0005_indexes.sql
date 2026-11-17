-- migrate:no-transaction
-- 0005 indexes for the hot read paths, built without blocking writes.
-- CONCURRENTLY cannot run inside a transaction, so the runner executes each
-- statement on its own. If a build is interrupted it leaves an INVALID index:
-- drop it with DROP INDEX CONCURRENTLY and run the migration again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_last_message ON conversations (last_message_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_order ON tickets (order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotations_assigned_staff ON quotations (assigned_staff_id);
-- Duplicates of the indexes behind the UNIQUE constraints on orders.reference and clients.whatsapp_number
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_reference;
DROP INDEX CONCURRENTLY IF EXISTS idx_clients_whatsapp;
