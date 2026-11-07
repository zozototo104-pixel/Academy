-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN "emailClaimId" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "emailClaimLeaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SupervisorChannelMessage" ADD COLUMN "emailClaimId" TEXT;
ALTER TABLE "SupervisorChannelMessage" ADD COLUMN "emailClaimLeaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationOutboxRecipient" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "providerRef" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutboxRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationOutboxRecipient_outboxId_status_idx" ON "NotificationOutboxRecipient"("outboxId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutboxRecipient_outboxId_recipientUserId_key" ON "NotificationOutboxRecipient"("outboxId", "recipientUserId");

-- AddForeignKey
ALTER TABLE "NotificationOutboxRecipient" ADD CONSTRAINT "NotificationOutboxRecipient_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "NotificationOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
