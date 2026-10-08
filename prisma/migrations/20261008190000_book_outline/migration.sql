CREATE TABLE "BookOutline" (
  "id" TEXT NOT NULL,
  "bookId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookOutline_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BookOutline_bookId_version_key" ON "BookOutline"("bookId", "version");
CREATE INDEX "BookOutline_bookId_createdAt_idx" ON "BookOutline"("bookId", "createdAt");
ALTER TABLE "BookOutline" ADD CONSTRAINT "BookOutline_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BookOutlineSection" (
  "id" TEXT NOT NULL,
  "outlineId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "level" INTEGER NOT NULL DEFAULT 1,
  "semester" INTEGER,
  "chunkStartIndex" INTEGER NOT NULL,
  "chunkEndIndex" INTEGER NOT NULL,
  "pageStart" INTEGER,
  "pageEnd" INTEGER,
  "itemsCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "BookOutlineSection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BookOutlineSection_outlineId_order_key" ON "BookOutlineSection"("outlineId", "order");
CREATE INDEX "BookOutlineSection_outlineId_chunkStartIndex_idx" ON "BookOutlineSection"("outlineId", "chunkStartIndex");
ALTER TABLE "BookOutlineSection" ADD CONSTRAINT "BookOutlineSection_outlineId_fkey" FOREIGN KEY ("outlineId") REFERENCES "BookOutline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Unit" ADD COLUMN "sourceBookId" TEXT;
ALTER TABLE "Unit" ADD COLUMN "outlineSectionId" TEXT;
ALTER TABLE "Unit" ADD COLUMN "chunkStartIndex" INTEGER;
ALTER TABLE "Unit" ADD COLUMN "chunkEndIndex" INTEGER;
ALTER TABLE "Unit" ADD COLUMN "generationVersion" INTEGER NOT NULL DEFAULT 0;
