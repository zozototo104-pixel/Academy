CREATE TABLE IF NOT EXISTS "KeyRateWindow" (
  "id" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "window" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KeyRateWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KeyRateWindow_keyHash_window_windowStart_key"
  ON "KeyRateWindow"("keyHash", "window", "windowStart");

CREATE INDEX IF NOT EXISTS "KeyRateWindow_windowStart_idx"
  ON "KeyRateWindow"("windowStart");
