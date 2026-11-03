-- Bulk legacy-certificate ZIP imports become resumable sessions: the
-- archive stays in file storage and the run (counts + per-file results)
-- is recorded in this table, so an admin can complete a partial import
-- later, from any device, instead of re-uploading from a page whose
-- in-memory file selection vanishes on refresh.
CREATE TABLE "LegacyCertificateZipImport" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "totalFiles" INTEGER,
    "successful" INTEGER,
    "notFound" INTEGER,
    "rejected" INTEGER,
    "failed" INTEGER,
    "results" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyCertificateZipImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LegacyCertificateZipImport_createdAt_idx" ON "LegacyCertificateZipImport"("createdAt");
