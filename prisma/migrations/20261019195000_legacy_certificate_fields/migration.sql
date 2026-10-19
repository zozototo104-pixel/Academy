-- Additive fields for certificates imported from pre-platform legacy graduates.
-- No existing Certificate columns are removed or changed.
-- IF NOT EXISTS is intentional: the branch already contains an earlier migration
-- that can add some legacy columns before this migration runs in the shadow DB.
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "legacy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "legacySerial" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "uploadedFileKey" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "uploadedFileName" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "uploadedMime" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "stampedFileKey" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "qrPosition" TEXT;
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "qrSize" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_legacySerial_key" ON "Certificate"("legacySerial");
