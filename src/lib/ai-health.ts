import { db } from '@/lib/db'

type RawQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

const AI_HEALTH_SETTING_KEY = 'AI_HEALTH_LAST_RUN'
const AI_HEALTH_INTERVAL_MS = 60 * 60 * 1000

export async function claimAiHealthRun(client: RawQueryClient = db, nowMs = Date.now()): Promise<boolean> {
  const cutoffMs = nowMs - AI_HEALTH_INTERVAL_MS
  const rows = await client.$queryRawUnsafe<Array<{ key: string }>>(
    `INSERT INTO "Setting" ("key", "value", "updatedAt")
     VALUES ('AI_HEALTH_LAST_RUN', $1, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
     WHERE CASE
       WHEN "Setting"."value" ~ '^[0-9]+$' THEN "Setting"."value"::bigint
       ELSE 0
     END < $2
     RETURNING "key"`,
    String(nowMs),
    cutoffMs,
  )
  return rows.length > 0
}

export const __testAiHealthClaimConstants = { AI_HEALTH_SETTING_KEY, AI_HEALTH_INTERVAL_MS }
