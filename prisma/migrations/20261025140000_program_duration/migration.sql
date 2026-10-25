-- Program study max duration (per program) + extension requests + daily reminder marker.
ALTER TABLE "Program" ADD COLUMN "maxStudyDays" INTEGER;
ALTER TABLE "Enrollment" ADD COLUMN "extensionDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Enrollment" ADD COLUMN "lastReminderAt" TIMESTAMP(3);
CREATE TABLE "ProgramExtensionRequest" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "requestedDays" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "grantedDays" INTEGER,
  "adminNote" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProgramExtensionRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProgramExtensionRequest_enrollmentId_status_idx" ON "ProgramExtensionRequest"("enrollmentId", "status");
CREATE INDEX "ProgramExtensionRequest_status_createdAt_idx" ON "ProgramExtensionRequest"("status", "createdAt");
ALTER TABLE "ProgramExtensionRequest" ADD CONSTRAINT "ProgramExtensionRequest_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProgramExtensionRequest" ADD CONSTRAINT "ProgramExtensionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProgramExtensionRequest" ADD CONSTRAINT "ProgramExtensionRequest_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
