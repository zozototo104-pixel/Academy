-- Comprehensive exam phase 3: structured specialization on the exam.
-- Additive only: one nullable FK on ComprehensiveExam + the live-exam
-- unique index widens from (program, status) to (program, specialization,
-- status). No existing rows are touched: specializationProgramId defaults
-- NULL (pre-phase-3 exams keep working as legacy rows). The equivalency
-- program itself is NOT marked by a flag: it is the service Program row
-- (category SERVICE, slug 'training-certificates-equivalency'), resolved
-- by getServiceFlow — see the corrected design. This migration is a FILE
-- ONLY: it must never be applied to a live database by this change;
-- deployment applies it via the normal migrate path after the owner
-- approves the branch.
ALTER TABLE "ComprehensiveExam" ADD COLUMN "specializationProgramId" TEXT;

DROP INDEX "ComprehensiveExam_programId_status_key";
CREATE INDEX "ComprehensiveExam_programId_specializationProgramId_status_idx" ON "ComprehensiveExam"("programId", "specializationProgramId", "status");

ALTER TABLE "ComprehensiveExam" ADD CONSTRAINT "ComprehensiveExam_specializationProgramId_fkey" FOREIGN KEY ("specializationProgramId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ComprehensiveExam_specializationProgramId_idx" ON "ComprehensiveExam"("specializationProgramId");
