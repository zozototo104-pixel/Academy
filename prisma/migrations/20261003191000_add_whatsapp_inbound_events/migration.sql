-- CreateEnum
CREATE TYPE "WhatsAppInboundEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "WhatsAppInboundEvent" (
    "id" TEXT NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "waIdHash" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "messageType" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WhatsAppInboundEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppInboundEvent_waMessageId_key" ON "WhatsAppInboundEvent"("waMessageId");

-- CreateIndex
CREATE INDEX "WhatsAppInboundEvent_status_createdAt_idx" ON "WhatsAppInboundEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppInboundEvent_waIdHash_createdAt_idx" ON "WhatsAppInboundEvent"("waIdHash", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsAppInboundEvent_phoneNumberId_createdAt_idx" ON "WhatsAppInboundEvent"("phoneNumberId", "createdAt");
