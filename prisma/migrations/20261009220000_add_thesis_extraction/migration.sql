ALTER TABLE "ThesisSubmission" ADD COLUMN "extractionStatus" TEXT;
ALTER TABLE "ThesisSubmission" ADD COLUMN "extractionError" TEXT;
ALTER TABLE "ThesisSubmission" ADD COLUMN "extractionLockedUntil" TIMESTAMP(3);
ALTER TABLE "ThesisSubmission" ADD COLUMN "extractionPagesDone" INTEGER DEFAULT 0;
ALTER TABLE "ThesisSubmission" ADD COLUMN "extractionTotalPages" INTEGER;
ALTER TABLE "ThesisSubmission" ADD COLUMN "wordCount" INTEGER;
ALTER TABLE "ThesisSubmission" ADD COLUMN "pageCount" INTEGER;
ALTER TABLE "ThesisSubmission" ADD COLUMN "digest" JSONB;
ALTER TABLE "ThesisSubmission" ADD COLUMN "extractedAt" TIMESTAMP(3);
ALTER TABLE "ThesisSubmission" ADD COLUMN "fileName" TEXT;
ALTER TABLE "ThesisSubmission" ADD COLUMN "fileMime" TEXT;
ALTER TABLE "ThesisSubmission" ADD COLUMN "fileSize" INTEGER;
ALTER TABLE "ThesisSubmission" ADD COLUMN "defenseBreakdown" JSONB;

CREATE TABLE "ThesisChunk" (
  "id" TEXT NOT NULL,
  "thesisId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "pageStart" INTEGER,
  "pageEnd" INTEGER,
  "text" TEXT NOT NULL,
  "summary" TEXT,
  "status" TEXT NOT NULL DEFAULT 'EXTRACTED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ThesisChunk_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ThesisChunk" ADD CONSTRAINT "ThesisChunk_thesisId_fkey" FOREIGN KEY ("thesisId") REFERENCES "ThesisSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ThesisChunk_thesisId_index_key" ON "ThesisChunk"("thesisId", "index");
CREATE INDEX "ThesisChunk_thesisId_status_index_idx" ON "ThesisChunk"("thesisId", "status", "index");
