-- D1: per-stage pipeline profile storage with append-only versions.
-- Additive only: two new tables; nothing existing is altered.
CREATE TABLE "AiStageProfile" (
    "id" TEXT NOT NULL,
    "stage" "AiPipelineStage" NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiStageProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiStageProfile_stage_key" ON "AiStageProfile"("stage");

CREATE TABLE "AiStageProfileVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiStageProfileVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiStageProfileVersion_profileId_version_key" ON "AiStageProfileVersion"("profileId", "version");
CREATE INDEX "AiStageProfileVersion_profileId_version_idx" ON "AiStageProfileVersion"("profileId", "version");

ALTER TABLE "AiStageProfileVersion" ADD CONSTRAINT "AiStageProfileVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AiStageProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
