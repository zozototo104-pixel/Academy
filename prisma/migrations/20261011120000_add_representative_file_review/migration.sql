ALTER TABLE "AcademyRepresentativeFile"
  ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

CREATE INDEX IF NOT EXISTS "AcademyRepresentativeFile_reviewStatus_idx" ON "AcademyRepresentativeFile"("reviewStatus");
