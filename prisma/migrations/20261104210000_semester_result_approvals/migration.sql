-- Semester result approvals: an independent stored decision record for the
-- administration's approval of a semester result (Phase 2 of the academic
-- lifecycle plan). Grade review fields on attempts (reviewedById/reviewedAt)
-- are a different operation and are not reused for this approval. The
-- approval stays inert until the per-semester average engine (Phase 3) and
-- the semester lifecycle (Phase 4) land; the server guard refuses decisions
-- while any grade in the semester is unapproved or under review/appeal.
CREATE TABLE "SemesterResultApproval" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "score" DOUBLE PRECISION,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SemesterResultApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SemesterResultApproval_enrollmentId_semester_key" ON "SemesterResultApproval"("enrollmentId", "semester");

CREATE INDEX "SemesterResultApproval_enrollmentId_idx" ON "SemesterResultApproval"("enrollmentId");
