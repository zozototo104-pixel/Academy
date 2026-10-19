ALTER TABLE "Certificate"
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacySerial" TEXT,
  ADD COLUMN "uploadedFileKey" TEXT,
  ADD COLUMN "uploadedFileName" TEXT,
  ADD COLUMN "uploadedMime" TEXT,
  ADD COLUMN "stampedFileKey" TEXT,
  ADD COLUMN "qrPosition" TEXT,
  ADD COLUMN "qrSize" TEXT;

CREATE UNIQUE INDEX "Certificate_legacySerial_key" ON "Certificate"("legacySerial");
