CREATE TABLE "SupervisorAssessmentAttemptWindow" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restarts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupervisorAssessmentAttemptWindow_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupervisorAssessmentAttemptWindow_assessmentId_studentId_key" ON "SupervisorAssessmentAttemptWindow"("assessmentId", "studentId");
CREATE INDEX "SupervisorAssessmentAttemptWindow_studentId_idx" ON "SupervisorAssessmentAttemptWindow"("studentId");
