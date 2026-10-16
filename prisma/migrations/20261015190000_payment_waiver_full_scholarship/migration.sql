-- Add full-scholarship state and waiver-delivery tracking.
ALTER TABLE "AdmissionApplication"
  ADD COLUMN IF NOT EXISTS "scholarshipFull" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PaymentWaiverCode"
  ADD COLUMN IF NOT EXISTS "emailStatus" TEXT NOT NULL DEFAULT 'SKIPPED',
  ADD COLUMN IF NOT EXISTS "emailSentAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PaymentWaiverAttempt" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentWaiverAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaymentWaiverAttempt_paymentId_userId_success_createdAt_idx"
  ON "PaymentWaiverAttempt"("paymentId", "userId", "success", "createdAt");
