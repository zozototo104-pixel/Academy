-- CreateTable
CREATE TABLE "GradeApproval" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GradeApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GradeApproval_userId_programId_semester_idx" ON "GradeApproval"("userId", "programId", "semester");

-- CreateIndex
CREATE UNIQUE INDEX "GradeApproval_targetType_attemptId_key" ON "GradeApproval"("targetType", "attemptId");
