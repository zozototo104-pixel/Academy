CREATE TABLE "ThesisUploadChunk" (
  "id" TEXT NOT NULL,
  "uploadId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "thesisId" TEXT NOT NULL,
  "index" INTEGER NOT NULL,
  "data" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ThesisUploadChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ThesisUploadChunk_uploadId_index_key" ON "ThesisUploadChunk"("uploadId", "index");
CREATE INDEX "ThesisUploadChunk_uploadId_userId_thesisId_idx" ON "ThesisUploadChunk"("uploadId", "userId", "thesisId");
CREATE INDEX "ThesisUploadChunk_createdAt_idx" ON "ThesisUploadChunk"("createdAt");
