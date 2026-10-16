ALTER TABLE "Certificate"
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "revokedById" TEXT;

CREATE INDEX IF NOT EXISTS "Certificate_valid_revokedAt_idx"
  ON "Certificate"("valid", "revokedAt");
