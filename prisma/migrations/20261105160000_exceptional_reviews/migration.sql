-- CreateTable
CREATE TABLE "ExceptionalReview" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExceptionalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExceptionalReview_enrollmentId_semester_status_idx" ON "ExceptionalReview"("enrollmentId", "semester", "status");
