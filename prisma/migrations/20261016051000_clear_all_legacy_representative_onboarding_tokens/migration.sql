-- Remove all legacy raw representative onboarding tokens after hashed-token rollout.
UPDATE "AcademyRepresentative"
SET "onboardingToken" = NULL
WHERE "onboardingToken" IS NOT NULL;
