-- Additive, safe: new UnitRegenerationDraft table only; no column dropped,
-- renamed or backfilled on any existing table. Never applied by hand here;
-- applied by the normal deploy migration step only.
CREATE TABLE "UnitRegenerationDraft" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "objectives" TEXT,
    "content" TEXT NOT NULL,
    "gaps" TEXT,
    "sourceKnowledgeIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "UnitRegenerationDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UnitRegenerationDraft_unitId_status_idx" ON "UnitRegenerationDraft"("unitId", "status");
CREATE INDEX "UnitRegenerationDraft_programId_idx" ON "UnitRegenerationDraft"("programId");

ALTER TABLE "UnitRegenerationDraft" ADD CONSTRAINT "UnitRegenerationDraft_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
