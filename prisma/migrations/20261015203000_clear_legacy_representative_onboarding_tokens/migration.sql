-- Remove legacy raw onboarding tokens that predate hashed-token storage.
UPDATE "AcademyRepresentative"
SET "onboardingToken" = NULL
WHERE "onboardingToken" IS NOT NULL
  AND "onboardingTokenHash" IS NULL;
