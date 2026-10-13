-- Stage C completion/certificate integrity hardening.
-- Defensive deploy-safe migration: repair historical certificate rows before adding FK/unique constraints.
-- No certificates are deleted. Rows that cannot safely satisfy Certificate(enrollmentId,type)
-- keep their certificate record, but lose the unsafe enrollment link and are audited.

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

-- Orphan enrollment links would break the FK. Audit and unlink them instead of aborting deploy.
WITH orphaned AS (
  SELECT c."id", c."enrollmentId"
  FROM "Certificate" c
  WHERE c."enrollmentId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."id" = c."enrollmentId")
)
INSERT INTO "AuditLog" ("id", "actorId", "actorName", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'audit_' || substr(md5(o."id" || o."enrollmentId" || clock_timestamp()::text || random()::text), 1, 20),
  NULL,
  'system:migration',
  'CERTIFICATE_ORPHAN_ENROLLMENT_NULLIFIED',
  'Certificate',
  o."id",
  'Stage C migration cleared orphan Certificate.enrollmentId=' || o."enrollmentId" || ' before adding the FK.',
  now()
FROM orphaned o;

UPDATE "Certificate" c
SET "enrollmentId" = NULL
WHERE c."enrollmentId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."id" = c."enrollmentId");

-- Historical orphan user links would break the user FK. Audit and unlink them too.
WITH orphaned AS (
  SELECT c."id", c."userId"
  FROM "Certificate" c
  WHERE c."userId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = c."userId")
)
INSERT INTO "AuditLog" ("id", "actorId", "actorName", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'audit_' || substr(md5(o."id" || o."userId" || clock_timestamp()::text || random()::text), 1, 20),
  NULL,
  'system:migration',
  'CERTIFICATE_ORPHAN_USER_NULLIFIED',
  'Certificate',
  o."id",
  'Stage C migration cleared orphan Certificate.userId=' || o."userId" || ' before adding the FK.',
  now()
FROM orphaned o;

UPDATE "Certificate" c
SET "userId" = NULL
WHERE c."userId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = c."userId");

-- Duplicate enrollment/type rows would break the unique index. Keep the newest valid row;
-- unlink and invalidate the rest while preserving every certificate record.
WITH ranked AS (
  SELECT
    c."id",
    c."enrollmentId",
    c."type",
    row_number() OVER (
      PARTITION BY c."enrollmentId", c."type"
      ORDER BY c."valid" DESC, c."issuedAt" DESC, c."id" DESC
    ) AS rn,
    first_value(c."id") OVER (
      PARTITION BY c."enrollmentId", c."type"
      ORDER BY c."valid" DESC, c."issuedAt" DESC, c."id" DESC
    ) AS kept_id
  FROM "Certificate" c
  WHERE c."enrollmentId" IS NOT NULL
), duplicates AS (
  SELECT * FROM ranked WHERE rn > 1
)
INSERT INTO "AuditLog" ("id", "actorId", "actorName", "action", "entity", "entityId", "details", "createdAt")
SELECT
  'audit_' || substr(md5(d."id" || d."enrollmentId" || d."type" || clock_timestamp()::text || random()::text), 1, 20),
  NULL,
  'system:migration',
  'CERTIFICATE_DUPLICATE_ENROLLMENT_TYPE_INVALIDATED',
  'Certificate',
  d."id",
  'Stage C migration preserved duplicate Certificate but set enrollmentId=NULL and valid=false for duplicate (' || d."enrollmentId" || ',' || d."type" || '); kept certificate ' || d.kept_id || '.',
  now()
FROM duplicates d;

WITH ranked AS (
  SELECT
    c."id",
    row_number() OVER (
      PARTITION BY c."enrollmentId", c."type"
      ORDER BY c."valid" DESC, c."issuedAt" DESC, c."id" DESC
    ) AS rn
  FROM "Certificate" c
  WHERE c."enrollmentId" IS NOT NULL
)
UPDATE "Certificate" c
SET "enrollmentId" = NULL,
    "valid" = false
FROM ranked r
WHERE c."id" = r."id"
  AND r.rn > 1;

ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_userId_fkey";
ALTER TABLE "Enrollment" DROP CONSTRAINT IF EXISTS "Enrollment_programId_fkey";
ALTER TABLE "ExamAttempt" DROP CONSTRAINT IF EXISTS "ExamAttempt_userId_fkey";
ALTER TABLE "ProgramExamAttempt" DROP CONSTRAINT IF EXISTS "ProgramExamAttempt_userId_fkey";
ALTER TABLE "Certificate" DROP CONSTRAINT IF EXISTS "Certificate_userId_fkey";
ALTER TABLE "Certificate" DROP CONSTRAINT IF EXISTS "Certificate_enrollmentId_fkey";
ALTER TABLE "ThesisSubmission" DROP CONSTRAINT IF EXISTS "ThesisSubmission_userId_fkey";

CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_enrollmentId_type_key"
  ON "Certificate"("enrollmentId", "type");

CREATE SEQUENCE IF NOT EXISTS "Certificate_serial_seq";
SELECT setval(
  '"Certificate_serial_seq"',
  GREATEST(
    1,
    COALESCE((
      SELECT MAX((regexp_match("serial", '-([0-9]+)
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
))[1]::bigint) + 1
      FROM "Certificate"
      WHERE "serial" ~ '-[0-9]+
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

    ), 1)
  ),
  false
);

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
