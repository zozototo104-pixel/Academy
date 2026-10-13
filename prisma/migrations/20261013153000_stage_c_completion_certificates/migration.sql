-- Stage C completion/certificate integrity hardening.
-- This migration is intentionally defensive: it refuses to add the unique enrollment/type
-- constraint if existing production data contains duplicates that would make the index unsafe.

-- Best-effort backfill for historical PROGRAM_COMPLETION certificates that predate enrollmentId.
UPDATE "Certificate" AS c
SET "enrollmentId" = e."id"
FROM "AdmissionApplication" AS a
JOIN "Enrollment" AS e ON e."userId" = a."userId" AND e."programId" = a."programId"
WHERE c."type" = 'PROGRAM_COMPLETION'
  AND c."enrollmentId" IS NULL
  AND c."admissionId" = a."id";

UPDATE "Certificate" AS c
SET "enrollmentId" = e."id"
FROM "Enrollment" AS e
JOIN "Program" AS p ON p."id" = e."programId"
WHERE c."type" = 'PROGRAM_COMPLETION'
  AND c."enrollmentId" IS NULL
  AND c."userId" = e."userId"
  AND (c."program" = p."titleAr" OR c."program" = p."titleEn");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Certificate"
    WHERE "enrollmentId" IS NOT NULL
    GROUP BY "enrollmentId", "type"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add Certificate(enrollmentId,type) unique constraint: duplicate certificates exist. Resolve duplicates before deploying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Certificate" c
    WHERE c."enrollmentId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."id" = c."enrollmentId")
  ) THEN
    RAISE EXCEPTION 'Cannot add Certificate.enrollmentId foreign key: orphan certificate enrollmentId values exist.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Certificate" c
    WHERE c."userId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = c."userId")
  ) THEN
    RAISE EXCEPTION 'Cannot add Certificate.userId foreign key: orphan certificate userId values exist.';
  END IF;
END $$;

ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_userId_fkey";
ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_programId_fkey";
ALTER TABLE "ExamAttempt" DROP CONSTRAINT IF EXISTS "ExamAttempt_userId_fkey";
ALTER TABLE "ProgramExamAttempt" DROP CONSTRAINT IF EXISTS "ProgramExamAttempt_userId_fkey";
ALTER TABLE "Certificate" DROP CONSTRAINT IF EXISTS "Certificate_userId_fkey";
ALTER TABLE "Certificate" DROP CONSTRAINT IF EXISTS "Certificate_enrollmentId_fkey";
ALTER TABLE "ThesisSubmission" DROP CONSTRAINT IF EXISTS "ThesisSubmission_userId_fkey";

CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_enrollmentId_type_key"
  ON "Certificate"("enrollmentId", "type");

ALTER TABLE "Enrollment"
  ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Enrollment"
  ADD CONSTRAINT "Enrollment_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExamAttempt"
  ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProgramExamAttempt"
  ADD CONSTRAINT "ProgramExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Certificate"
  ADD CONSTRAINT "Certificate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Certificate"
  ADD CONSTRAINT "Certificate_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ThesisSubmission"
  ADD CONSTRAINT "ThesisSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
