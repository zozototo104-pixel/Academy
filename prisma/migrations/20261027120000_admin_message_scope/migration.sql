-- Admin messaging: separate admin threads from supervision + audience selector + unread-email marker.
-- Existing rows keep supervision behavior: scope defaults to SUPERVISION, audience to ALL.
ALTER TABLE "SupervisorChannelMessage" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'SUPERVISION';
ALTER TABLE "SupervisorChannelMessage" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "SupervisorChannelMessage" ADD COLUMN "emailSentAt" TIMESTAMP(3);
CREATE INDEX "SupervisorChannelMessage_admissionId_scope_idx" ON "SupervisorChannelMessage"("admissionId", "scope");
CREATE INDEX "SupervisorChannelMessage_scope_senderRole_emailSentAt_idx" ON "SupervisorChannelMessage"("scope", "senderRole", "emailSentAt");
