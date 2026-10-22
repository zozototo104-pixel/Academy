-- D3.2a: bounded auto re-verification queue (data layer only).
-- Additive only: two enums + one new table; nothing existing is altered.
CREATE TYPE "QuestionRecheckReason" AS ENUM ('REVIEW_PROFILE_CHANGED', 'NEW_EVIDENCE_AVAILABLE', 'MANUAL_ADMIN_RECHECK');

CREATE TYPE "QuestionRecheckTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

CREATE TABLE "QuestionRecheckTask" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "reason" "QuestionRecheckReason" NOT NULL,
    "status" "QuestionRecheckTaskStatus" NOT NULL DEFAULT 'PENDING',
    "profileVersion" TEXT,
    "recommendation" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "QuestionRecheckTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuestionRecheckTask_status_createdAt_idx" ON "QuestionRecheckTask"("status", "createdAt");
CREATE INDEX "QuestionRecheckTask_questionId_createdAt_idx" ON "QuestionRecheckTask"("questionId", "createdAt");

ALTER TABLE "QuestionRecheckTask" ADD CONSTRAINT "QuestionRecheckTask_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuestionBankItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
