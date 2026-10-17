ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "passwordResetUsedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_emailVerificationTokenHash_idx" ON "User"("emailVerificationTokenHash");
CREATE INDEX IF NOT EXISTS "User_emailVerifiedAt_idx" ON "User"("emailVerifiedAt");
CREATE INDEX IF NOT EXISTS "User_passwordResetTokenHash_idx" ON "User"("passwordResetTokenHash");
