-- CreateTable
CREATE TABLE "SemesterDecision" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "intent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NONE',
    "raiseSource" TEXT,
    "intentAt" TIMESTAMP(3),
    "raisedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "scoreAtIntent" DOUBLE PRECISION,
    "scoreAtRaise" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SemesterDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SemesterDecision_status_idx" ON "SemesterDecision"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SemesterDecision_enrollmentId_semester_key" ON "SemesterDecision"("enrollmentId", "semester");
