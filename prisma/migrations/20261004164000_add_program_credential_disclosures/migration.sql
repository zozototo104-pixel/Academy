-- Add program-level credential and disclosure fields used by the canonical admission rules editor.
ALTER TABLE "Program" ADD COLUMN "credentialType" TEXT;
ALTER TABLE "Program" ADD COLUMN "trademarkNotice" TEXT;
ALTER TABLE "Program" ADD COLUMN "disclosureConsentText" TEXT;
