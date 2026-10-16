-- Backfill old thesis records that were created before ThesisSubmission.admissionId was enforced.
-- Only auto-link when the student has exactly one non-rejected admission application,
-- so multi-program students are not linked to the wrong program.
WITH single_admission AS (
  SELECT "userId", MIN(id) AS "admissionId"
  FROM "AdmissionApplication"
  WHERE "userId" IS NOT NULL
    AND status <> 'REJECTED'
  GROUP BY "userId"
  HAVING COUNT(*) = 1
)
UPDATE "ThesisSubmission" t
SET "admissionId" = s."admissionId"
FROM single_admission s
WHERE t."admissionId" IS NULL
  AND t."userId" = s."userId";
