-- Additive, safe: new UnitRegenerationIntent table only; no column dropped,
-- renamed or backfilled on any existing table. Never applied by hand here;
-- applied by the normal deploy migration step only.
CREATE TABLE "UnitRegenerationIntent" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "repairJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "UnitRegenerationIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnitRegenerationIntent_unitId_status_key" ON "UnitRegenerationIntent"("unitId", "status");
CREATE INDEX "UnitRegenerationIntent_bookId_status_idx" ON "UnitRegenerationIntent"("bookId", "status");

ALTER TABLE "UnitRegenerationIntent" ADD CONSTRAINT "UnitRegenerationIntent_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
