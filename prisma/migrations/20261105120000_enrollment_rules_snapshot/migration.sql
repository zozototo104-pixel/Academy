-- CreateTable
CREATE TABLE "EnrollmentRulesSnapshot" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "weightsJson" TEXT NOT NULL,
    "weightSource" TEXT NOT NULL,
    "weightWarning" TEXT,
    "passThreshold" INTEGER NOT NULL DEFAULT 50,
    "thresholdStrict" BOOLEAN NOT NULL DEFAULT true,
    "requirementsJson" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'ENROLLMENT',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrollmentRulesSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnrollmentRulesSnapshot_enrollmentId_key" ON "EnrollmentRulesSnapshot"("enrollmentId");

-- CreateIndex
CREATE INDEX "EnrollmentRulesSnapshot_userId_programId_idx" ON "EnrollmentRulesSnapshot"("userId", "programId");
