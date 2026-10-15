ALTER TABLE "AcademyRepresentative"
  ADD COLUMN IF NOT EXISTS "onboardingTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingExpiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "AcademyRepresentative_onboardingTokenHash_idx"
  ON "AcademyRepresentative"("onboardingTokenHash");

CREATE INDEX IF NOT EXISTS "AcademyRepresentative_onboardingExpiresAt_idx"
  ON "AcademyRepresentative"("onboardingExpiresAt");
