CREATE TABLE "QuestionBankGenerationJob" (
  "id" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "unitId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "requested" INTEGER NOT NULL DEFAULT 0,
  "saved" INTEGER NOT NULL DEFAULT 0,
  "batchSize" INTEGER NOT NULL DEFAULT 4,
  "sourceScope" TEXT NOT NULL DEFAULT 'PROGRAM',
  "lastError" TEXT,
  "retryAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuestionBankGenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuestionBankGenerationJob_programId_status_idx" ON "QuestionBankGenerationJob"("programId", "status");
CREATE INDEX "QuestionBankGenerationJob_unitId_status_idx" ON "QuestionBankGenerationJob"("unitId", "status");
CREATE INDEX "QuestionBankGenerationJob_status_retryAt_idx" ON "QuestionBankGenerationJob"("status", "retryAt");
