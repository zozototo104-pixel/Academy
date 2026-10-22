-- E1 advisor recommendations: persisted review suggestions only.
-- No migration writes or rewrites existing stage profiles.

CREATE TABLE "AiAdvisorAdvice" (
    "id" TEXT NOT NULL,
    "stage" "AiPipelineStage" NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "proposedSnapshot" JSONB,
    "signature" TEXT NOT NULL,
    "activeDedupKey" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedBy" TEXT,

    CONSTRAINT "AiAdvisorAdvice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiAdvisorAdvice_activeDedupKey_key" ON "AiAdvisorAdvice"("activeDedupKey");
CREATE INDEX "AiAdvisorAdvice_status_stage_createdAt_idx" ON "AiAdvisorAdvice"("status", "stage", "createdAt");
CREATE INDEX "AiAdvisorAdvice_category_createdAt_idx" ON "AiAdvisorAdvice"("category", "createdAt");
