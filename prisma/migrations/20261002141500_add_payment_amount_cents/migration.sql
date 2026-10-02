-- Store payment amounts in integer cents to avoid floating-point rounding in financial flows.
-- Keep the legacy Float amount column for backward compatibility during rollout.
ALTER TABLE "Payment" ADD COLUMN "amountCents" INTEGER;

UPDATE "Payment"
SET "amountCents" = ROUND("amount" * 100)::INTEGER
WHERE "amountCents" IS NULL;
