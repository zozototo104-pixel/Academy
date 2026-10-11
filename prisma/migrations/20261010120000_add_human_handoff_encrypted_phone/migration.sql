ALTER TABLE "HumanHandoffRequest"
  ADD COLUMN IF NOT EXISTS "phoneMasked" TEXT,
  ADD COLUMN IF NOT EXISTS "phoneHash" TEXT,
  ADD COLUMN IF NOT EXISTS "phoneEncrypted" TEXT;

CREATE INDEX IF NOT EXISTS "HumanHandoffRequest_phoneHash_idx" ON "HumanHandoffRequest"("phoneHash");
