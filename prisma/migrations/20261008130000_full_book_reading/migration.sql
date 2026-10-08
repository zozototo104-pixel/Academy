CREATE TABLE "BookChunk" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "pageStart" INTEGER NOT NULL,
  "pageEnd" INTEGER NOT NULL,
  "headingPath" TEXT,
  "text" TEXT NOT NULL,
  "charCount" INTEGER NOT NULL,
  "textProvenance" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookChunk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BookChunk_bookId_index_key" ON "BookChunk"("bookId", "index");
CREATE INDEX "BookChunk_bookId_status_idx" ON "BookChunk"("bookId", "status");
CREATE INDEX "BookChunk_programId_idx" ON "BookChunk"("programId");
ALTER TABLE "BookChunk" ADD CONSTRAINT "BookChunk_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BookReadJob" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "programId" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'EXTRACT',
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "totalPages" INTEGER NOT NULL DEFAULT 0,
  "pagesDone" INTEGER NOT NULL DEFAULT 0,
  "totalChunks" INTEGER NOT NULL DEFAULT 0,
  "chunksAnalyzed" INTEGER NOT NULL DEFAULT 0,
  "chunksFailed" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "retryAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookReadJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BookReadJob_bookId_status_idx" ON "BookReadJob"("bookId", "status");
CREATE INDEX "BookReadJob_status_retryAt_idx" ON "BookReadJob"("status", "retryAt");
ALTER TABLE "BookReadJob" ADD CONSTRAINT "BookReadJob_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookKnowledgeItem" ADD COLUMN "chunkId" TEXT,
ADD COLUMN "pageStart" INTEGER,
ADD COLUMN "pageEnd" INTEGER,
ADD COLUMN "textProvenance" TEXT,
ADD COLUMN "kbVersion" INTEGER NOT NULL DEFAULT 1;
