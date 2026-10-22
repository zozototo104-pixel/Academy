-- E4: advisor recommendations keep target profile version and lifecycle metadata.
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "targetProfileVersion" INTEGER;
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "evidenceSignature" TEXT;
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "appliedAt" TIMESTAMP(3);
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "appliedBy" TEXT;
ALTER TABLE "AiAdvisorAdvice" ADD COLUMN "appliedProfileVersion" INTEGER;

CREATE INDEX "AiAdvisorAdvice_status_expiresAt_idx" ON "AiAdvisorAdvice"("status", "expiresAt");
CREATE INDEX "AiAdvisorAdvice_signature_status_createdAt_idx" ON "AiAdvisorAdvice"("signature", "status", "createdAt");
