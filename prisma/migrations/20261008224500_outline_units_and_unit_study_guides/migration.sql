-- Add per-unit study guides while keeping old semester-level guides supported.
ALTER TABLE "ProgramStudyGuide" ADD COLUMN "unitId" TEXT;

ALTER TABLE "ProgramStudyGuide"
  ADD CONSTRAINT "ProgramStudyGuide_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The previous unique constraint made one guide per program/semester impossible to coexist
-- with per-unit guides. Replace it with partial unique indexes: one semester guide where
-- unitId is null, and at most one guide per unit.
DROP INDEX IF EXISTS "ProgramStudyGuide_programId_semester_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ProgramStudyGuide_programId_semester_root_key"
  ON "ProgramStudyGuide"("programId", "semester")
  WHERE "unitId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ProgramStudyGuide_unitId_key"
  ON "ProgramStudyGuide"("unitId")
  WHERE "unitId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ProgramStudyGuide_programId_semester_idx" ON "ProgramStudyGuide"("programId", "semester");
CREATE INDEX IF NOT EXISTS "ProgramStudyGuide_unitId_idx" ON "ProgramStudyGuide"("unitId");

CREATE INDEX IF NOT EXISTS "Unit_programId_semester_idx" ON "Unit"("programId", "semester");
CREATE INDEX IF NOT EXISTS "Unit_outlineSectionId_idx" ON "Unit"("outlineSectionId");
CREATE INDEX IF NOT EXISTS "Unit_sourceBookId_idx" ON "Unit"("sourceBookId");

CREATE TABLE "UnitGenerationJob" (
  "id" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "phase" TEXT NOT NULL DEFAULT 'CONTENT',
  "unitsTotal" INTEGER NOT NULL DEFAULT 1,
  "unitsDone" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "retryAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UnitGenerationJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UnitGenerationJob"
  ADD CONSTRAINT "UnitGenerationJob_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "UnitGenerationJob_unitId_status_idx" ON "UnitGenerationJob"("unitId", "status");
CREATE INDEX "UnitGenerationJob_status_retryAt_idx" ON "UnitGenerationJob"("status", "retryAt");
