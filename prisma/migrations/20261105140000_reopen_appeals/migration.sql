-- CreateTable
CREATE TABLE "ReopenAppeal" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "unitId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionDeadline" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReopenAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReopenAppeal_enrollmentId_semester_status_idx" ON "ReopenAppeal"("enrollmentId", "semester", "status");

-- CreateIndex
CREATE INDEX "ReopenAppeal_status_decisionDeadline_idx" ON "ReopenAppeal"("status", "decisionDeadline");
