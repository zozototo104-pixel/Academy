-- Keep the Stage C one-certificate-per-enrollment/type rule for ordinary
-- certificates, while allowing one comprehensive-exam certificate for each
-- specialization of the shared equivalency enrollment.
--
-- Existing rows are never deleted, unlinked or invalidated. Backfill the
-- specialization key for already-issued comprehensive-exam certificates
-- from their exam; all other certificates retain the BASE key.
BEGIN;

ALTER TABLE "Certificate"
  ADD COLUMN "certificateScope" TEXT NOT NULL DEFAULT 'BASE';

UPDATE "Certificate" AS c
SET "certificateScope" = exam."specializationProgramId"
FROM "ComprehensiveExam" AS exam
WHERE c."type" = 'COMPREHENSIVE_EXAM'
  AND c."comprehensiveExamId" = exam."id"
  AND exam."specializationProgramId" IS NOT NULL;

-- Replace the broader unique index only after the new key has been filled.
DROP INDEX "Certificate_enrollmentId_type_key";
CREATE UNIQUE INDEX "Certificate_enrollmentId_type_certificateScope_key"
  ON "Certificate"("enrollmentId", "type", "certificateScope");

COMMIT;
