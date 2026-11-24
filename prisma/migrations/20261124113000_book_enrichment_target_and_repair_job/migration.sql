-- Additive, safe: new nullable column on BookReadJob (old rows read NULL and
-- resolve to the base target 10 in code); new BookRepairJob table only.
-- Nothing is dropped, renamed or backfilled. Never applied by hand here;
-- applied by the normal deploy migration step only.
ALTER TABLE "BookReadJob" ADD COLUMN "enrichmentTarget" INTEGER;

CREATE TABLE "BookRepairJob" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "mode" TEXT NOT NULL DEFAULT 'SCAN',
    "chunksTotal" INTEGER NOT NULL DEFAULT 0,
    "chunksHealthy" INTEGER NOT NULL DEFAULT 0,
    "chunksCorrected" INTEGER NOT NULL DEFAULT 0,
    "chunksRemaining" INTEGER NOT NULL DEFAULT 0,
    "chunksNeedsReview" INTEGER NOT NULL DEFAULT 0,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsHealthy" INTEGER NOT NULL DEFAULT 0,
    "itemsCorrected" INTEGER NOT NULL DEFAULT 0,
    "itemsRemaining" INTEGER NOT NULL DEFAULT 0,
    "itemsNeedsReview" INTEGER NOT NULL DEFAULT 0,
    "progress" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookRepairJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookRepairJob_bookId_status_idx" ON "BookRepairJob"("bookId", "status");
CREATE INDEX "BookRepairJob_status_idx" ON "BookRepairJob"("status");

ALTER TABLE "BookRepairJob" ADD CONSTRAINT "BookRepairJob_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
