-- Comprehensive exam corrected apply rework: the application (not a
-- public page) carries the specialization, and the candidate links to the
-- existing registered user + the application (for the invite payment gate).
-- Additive only: one nullable FK on AdmissionApplication, two nullable
-- FKs on ComprehensiveExamCandidate and one nullable FK on Payment.
-- No existing rows are touched (all four columns default NULL).
-- This migration is a FILE ONLY: it must
-- never be applied to a live database by this change; deployment applies
-- it via the normal migrate path after the owner approves the branch.
ALTER TABLE "AdmissionApplication" ADD COLUMN "specializationProgramId" TEXT;

ALTER TABLE "ComprehensiveExamCandidate" ADD COLUMN "userId" TEXT;

ALTER TABLE "ComprehensiveExamCandidate" ADD COLUMN "admissionApplicationId" TEXT;

ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_specializationProgramId_fkey" FOREIGN KEY ("specializationProgramId") REFERENCES "Program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ComprehensiveExamCandidate" ADD CONSTRAINT "ComprehensiveExamCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ComprehensiveExamCandidate" ADD CONSTRAINT "ComprehensiveExamCandidate_admissionApplicationId_fkey" FOREIGN KEY ("admissionApplicationId") REFERENCES "AdmissionApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AdmissionApplication_specializationProgramId_idx" ON "AdmissionApplication"("specializationProgramId");

CREATE INDEX "ComprehensiveExamCandidate_userId_idx" ON "ComprehensiveExamCandidate"("userId");

CREATE INDEX "ComprehensiveExamCandidate_admissionApplicationId_idx" ON "ComprehensiveExamCandidate"("admissionApplicationId");

-- Administrative direct payments for manually entered exam candidates.
-- The nullable one-to-one FK never changes existing payment rows.
ALTER TABLE "Payment" ADD COLUMN "comprehensiveExamCandidateId" TEXT;
CREATE UNIQUE INDEX "Payment_comprehensiveExamCandidateId_key" ON "Payment"("comprehensiveExamCandidateId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_comprehensiveExamCandidateId_fkey" FOREIGN KEY ("comprehensiveExamCandidateId") REFERENCES "ComprehensiveExamCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
