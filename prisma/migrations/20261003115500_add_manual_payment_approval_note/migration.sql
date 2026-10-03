-- Manual approval evidence recorded by admin when confirming offline payments
ALTER TABLE "Payment" ADD COLUMN "manualApprovalReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "manualApprovalNote" TEXT;
