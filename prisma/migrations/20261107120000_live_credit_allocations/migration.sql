-- CreateTable
CREATE TABLE "AiLiveCreditAllocation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "creditId" TEXT,
    "minutesReserved" INTEGER NOT NULL,
    "minutesUsed" INTEGER NOT NULL DEFAULT 0,
    "minutesRefunded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiLiveCreditAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiLiveCreditAllocation_creditId_idx" ON "AiLiveCreditAllocation"("creditId");

-- CreateIndex
CREATE UNIQUE INDEX "AiLiveCreditAllocation_sessionId_creditId_key" ON "AiLiveCreditAllocation"("sessionId", "creditId");

-- AddForeignKey
ALTER TABLE "AiLiveCreditAllocation" ADD CONSTRAINT "AiLiveCreditAllocation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiLiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiLiveCreditAllocation" ADD CONSTRAINT "AiLiveCreditAllocation_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "AiLiveCredit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
