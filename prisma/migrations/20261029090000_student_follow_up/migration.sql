-- Student follow-up service (phase 1): last-activity stamp, per-enrollment
-- inactivity follow-up counters, and the follow-up message log.
ALTER TABLE "User" ADD COLUMN "lastActivityAt" TIMESTAMP(3);
ALTER TABLE "Enrollment" ADD COLUMN "followUpCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Enrollment" ADD COLUMN "lastFollowUpAt" TIMESTAMP(3);
CREATE TABLE "StudentFollowUpLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enrollmentId" TEXT,
    "kind" TEXT NOT NULL,
    "messageIndex" INTEGER NOT NULL DEFAULT 0,
    "daysAbsent" INTEGER NOT NULL DEFAULT 0,
    "platformSent" BOOLEAN NOT NULL DEFAULT false,
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "whatsappStatus" TEXT NOT NULL DEFAULT 'SKIPPED',
    "title" TEXT,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentFollowUpLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StudentFollowUpLog_userId_createdAt_idx" ON "StudentFollowUpLog"("userId", "createdAt");
CREATE INDEX "StudentFollowUpLog_enrollmentId_createdAt_idx" ON "StudentFollowUpLog"("enrollmentId", "createdAt");
ALTER TABLE "StudentFollowUpLog" ADD CONSTRAINT "StudentFollowUpLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
