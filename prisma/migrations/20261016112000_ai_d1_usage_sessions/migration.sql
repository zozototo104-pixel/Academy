CREATE TABLE IF NOT EXISTS "AiLiveSession" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'SUPERVISOR',
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "reservedMinutes" INTEGER NOT NULL,
  "freeReserved" INTEGER NOT NULL DEFAULT 0,
  "paidReserved" INTEGER NOT NULL DEFAULT 0,
  "actualMinutes" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiLiveSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiLiveSession_sessionId_key" ON "AiLiveSession"("sessionId");
CREATE INDEX IF NOT EXISTS "AiLiveSession_userId_status_idx" ON "AiLiveSession"("userId", "status");
CREATE INDEX IF NOT EXISTS "AiLiveSession_status_expiresAt_idx" ON "AiLiveSession"("status", "expiresAt");

DO $$ BEGIN
  ALTER TABLE "AiLiveSession" ADD CONSTRAINT "AiLiveSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AiUsageLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsageLog_provider_createdAt_idx" ON "AiUsageLog"("provider", "createdAt");

DO $$ BEGIN
  ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
