-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "waiverType" TEXT;
ALTER TABLE "Payment" ADD COLUMN "waiverStatus" TEXT;
ALTER TABLE "Payment" ADD COLUMN "waiverReason" TEXT;
ALTER TABLE "Payment" ADD COLUMN "waivedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "waivedAmountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "originalAmount" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "originalAmountCents" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "waiverApprovedById" TEXT;
ALTER TABLE "Payment" ADD COLUMN "waiverApprovedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentWaiverCode" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePreview" TEXT NOT NULL,
    "waiverType" TEXT NOT NULL,
    "requestedAmount" DOUBLE PRECISION,
    "requestedAmountCents" INTEGER,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedById" TEXT,
    "verifiedById" TEXT,
    "approvedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentWaiverCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWaiverCode_codeHash_key" ON "PaymentWaiverCode"("codeHash");
CREATE INDEX "PaymentWaiverCode_paymentId_status_idx" ON "PaymentWaiverCode"("paymentId", "status");
CREATE INDEX "PaymentWaiverCode_expiresAt_idx" ON "PaymentWaiverCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "PaymentWaiverCode" ADD CONSTRAINT "PaymentWaiverCode_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
