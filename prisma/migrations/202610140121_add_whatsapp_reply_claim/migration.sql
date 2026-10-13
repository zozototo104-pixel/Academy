-- Add an idempotency claim for automated WhatsApp replies.
-- Nullable unique columns are additive and allow existing conversation rows to remain valid.
ALTER TABLE "WhatsAppConversationMessage"
  ADD COLUMN IF NOT EXISTS "replyForMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppConversationMessage_replyForMessageId_key"
  ON "WhatsAppConversationMessage"("replyForMessageId");
