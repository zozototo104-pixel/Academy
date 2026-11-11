-- CreateTable
CREATE TABLE "ScholarshipDefinition" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GENERAL',
    "coverage" TEXT NOT NULL DEFAULT 'TUITION',
    "valueMode" TEXT NOT NULL DEFAULT 'FULL',
    "value" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScholarshipDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipDefinitionProgram" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "seats" INTEGER,

    CONSTRAINT "ScholarshipDefinitionProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipGrantLink" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "operationId" TEXT,
    "waiverCodeId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "percentBps" INTEGER,
    "baseCents" INTEGER NOT NULL,
    "grantCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScholarshipGrantLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipGrantOperation" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "admissionId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUING',
    "expectedCodes" INTEGER NOT NULL DEFAULT 0,
    "expectedCents" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScholarshipGrantOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipWaitlistEntry" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "admissionId" TEXT,
    "programId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "releaseKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScholarshipWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScholarshipDefinition_scope_active_idx" ON "ScholarshipDefinition"("scope", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ScholarshipDefinitionProgram_definitionId_programId_key" ON "ScholarshipDefinitionProgram"("definitionId", "programId");

-- CreateIndex
CREATE INDEX "ScholarshipDefinitionProgram_programId_idx" ON "ScholarshipDefinitionProgram"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "ScholarshipGrantLink_waiverCodeId_key" ON "ScholarshipGrantLink"("waiverCodeId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantLink_userId_idx" ON "ScholarshipGrantLink"("userId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantLink_admissionId_idx" ON "ScholarshipGrantLink"("admissionId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantLink_operationId_idx" ON "ScholarshipGrantLink"("operationId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantOperation_userId_idx" ON "ScholarshipGrantOperation"("userId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantOperation_admissionId_idx" ON "ScholarshipGrantOperation"("admissionId");

-- CreateIndex
CREATE INDEX "ScholarshipGrantOperation_definitionId_status_idx" ON "ScholarshipGrantOperation"("definitionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScholarshipWaitlistEntry_definitionId_userId_key" ON "ScholarshipWaitlistEntry"("definitionId", "userId");

-- CreateIndex
CREATE INDEX "ScholarshipWaitlistEntry_definitionId_status_createdAt_idx" ON "ScholarshipWaitlistEntry"("definitionId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ScholarshipDefinitionProgram" ADD CONSTRAINT "ScholarshipDefinitionProgram_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ScholarshipDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipGrantLink" ADD CONSTRAINT "ScholarshipGrantLink_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ScholarshipDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipGrantLink" ADD CONSTRAINT "ScholarshipGrantLink_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ScholarshipGrantOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipGrantOperation" ADD CONSTRAINT "ScholarshipGrantOperation_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ScholarshipDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipWaitlistEntry" ADD CONSTRAINT "ScholarshipWaitlistEntry_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ScholarshipDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
