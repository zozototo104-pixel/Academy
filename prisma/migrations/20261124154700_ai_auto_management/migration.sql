-- Auto AI provider/model management (steps 5-6): durable router-level
-- failover history. Pipeline runs already have AiPipelineOperationLog;
-- this covers non-pipeline router calls too. Additive only: one new
-- table, no changes to existing tables. AiDiscoveredModel / AiTaskRanking
-- stay Setting JSON (AI_AUTO_MODEL_CATALOG / AI_AUTO_RANKING:*) per plan.
CREATE TABLE "AiAutoFailoverEvent" (
    "id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text",
    "keyIndex" "integer",
    "purpose" "text",
    "taskType" "text",
    "failureKind" "text" NOT NULL,
    "cooldownScope" "text",
    "cooldownUntil" TIMESTAMP(3),
    "nextModel" "text",
    "detail" "jsonb",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAutoFailoverEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiAutoFailoverEvent_provider_createdAt_idx" ON "AiAutoFailoverEvent"("provider", "createdAt");
CREATE INDEX "AiAutoFailoverEvent_purpose_createdAt_idx" ON "AiAutoFailoverEvent"("purpose", "createdAt");
