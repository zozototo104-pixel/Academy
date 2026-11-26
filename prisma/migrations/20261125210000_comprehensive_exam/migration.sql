-- Comprehensive exam for external graduates (phase 1: preparation only).
-- Additive only: two new tables, no changes to existing tables.
-- Phase 2 (candidates, invitations, attempts, certificate link) gets its
-- own migration. This migration is a FILE ONLY: it must never be applied
-- to a live database by this change; deployment applies it via the
-- normal migrate path after the owner approves the branch.
CREATE TABLE "ComprehensiveExam" (
    "id" "text" NOT NULL,
    "programId" "text" NOT NULL,
    "level" "text" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" NOT NULL DEFAULT 'DRAFT',
    "passScore" INTEGER NOT NULL DEFAULT 60,
    "durationMin" INTEGER NOT NULL DEFAULT 120,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "publishedById" "text",
    "createdById" "text",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComprehensiveExam_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprehensiveExam_programId_status_key" ON "ComprehensiveExam"("programId", "status");
CREATE INDEX "ComprehensiveExam_programId_idx" ON "ComprehensiveExam"("programId");

ALTER TABLE "ComprehensiveExam" ADD CONSTRAINT "ComprehensiveExam_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComprehensiveExamQuestion" (
    "id" "text" NOT NULL,
    "examId" "text" NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "text" NOT NULL,
    "text" "text" NOT NULL,
    "options" "text",
    "correctAnswer" "text",
    "source" "text" NOT NULL,
    "sourceBookId" "text",
    "sourceEvidence" "text",
    "bankItemId" "text",
    "status" "text" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectedReason" "text",
    "approvedById" "text",
    "approvedAt" TIMESTAMP(3),
    "createdById" "text",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComprehensiveExamQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprehensiveExamQuestion_examId_order_key" ON "ComprehensiveExamQuestion"("examId", "order");
CREATE INDEX "ComprehensiveExamQuestion_examId_status_idx" ON "ComprehensiveExamQuestion"("examId", "status");

ALTER TABLE "ComprehensiveExamQuestion" ADD CONSTRAINT "ComprehensiveExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "ComprehensiveExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
