-- Additive fields for certificates imported from pre-platform legacy graduates.
-- No existing Certificate columns are removed or changed.
ALTER TABLE "Certificate" ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Certificate" ADD COLUMN "legacySerial" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "uploadedFileKey" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "uploadedFileName" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "uploadedMime" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "stampedFileKey" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "qrPosition" TEXT;
ALTER TABLE "Certificate" ADD COLUMN "qrSize" TEXT;

CREATE UNIQUE INDEX "Certificate_legacySerial_key" ON "Certificate"("legacySerial");
