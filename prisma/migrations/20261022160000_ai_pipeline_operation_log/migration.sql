-- D0: per-run telemetry for the book→questions AI pipeline.
-- Additive only: one enum + one table; nothing existing is altered.
CREATE TYPE "AiPipelineStage" AS ENUM ('READING', 'ANALYSIS', 'GENERATION', 'REVIEW');

CREATE TABLE "AiPipelineOperationLog" (
    "id" TEXT NOT NULL,
    "stage" "AiPipelineStage" NOT NULL,
    "profileId" TEXT NOT NULL DEFAULT 'global',
    "profileVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "policy" TEXT,
    "allowedModelsSnapshot" JSONB,
    "bookId" TEXT,
    "batchId" TEXT,
    "unitId" TEXT,
    "promptVersion" TEXT,
    "promptHash" TEXT,
    "inputHash" TEXT NOT NULL,
    "outputId" TEXT,
    "outputCount" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costCents" INTEGER,
    "success" BOOLEAN NOT NULL,
    "failureCategory" TEXT,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPipelineOperationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiPipelineOperationLog_stage_createdAt_idx" ON "AiPipelineOperationLog"("stage", "createdAt");
CREATE INDEX "AiPipelineOperationLog_bookId_createdAt_idx" ON "AiPipelineOperationLog"("bookId", "createdAt");
CREATE INDEX "AiPipelineOperationLog_profileVersion_createdAt_idx" ON "AiPipelineOperationLog"("profileVersion", "createdAt");
