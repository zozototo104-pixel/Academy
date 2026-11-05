-- CreateTable
CREATE TABLE "MercyRequest" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "initiatedBy" TEXT NOT NULL DEFAULT 'STUDENT',
    "activityTitle" TEXT,
    "activityInstructions" TEXT,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "weightPercent" INTEGER,
    "submissionText" TEXT,
    "submittedAt" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "gradedById" TEXT,
    "gradedAt" TIMESTAMP(3),
    "previousAverage" DOUBLE PRECISION,
    "newAverage" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercyRequest_enrollmentId_semester_key" ON "MercyRequest"("enrollmentId", "semester");
