import { db } from '@/lib/db'
import { AI_AUTO_MAX_AGE_MS } from '@/lib/ai-auto-policy'
import { textAiAutomaticManagementEnabled, textAiRefreshAutomaticCatalog } from '@/lib/text-ai'

export async function refreshAutomaticCatalog() {
  if (!await textAiAutomaticManagementEnabled()) return { refreshed: false, reason: 'disabled' }
  const now = Date.now()
  const claimed = await db.$queryRawUnsafe<Array<{ key: string }>>(
    `INSERT INTO "Setting" ("key", "value", "updatedAt")
     VALUES ('AI_AUTO_CATALOG_CLAIM', $1, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
     WHERE CASE WHEN "Setting"."value" ~ '^[0-9]+$' THEN "Setting"."value"::bigint ELSE 0 END < $2
     RETURNING "key"`,
    String(now), now - AI_AUTO_MAX_AGE_MS,
  )
  if (!claimed.length) return { refreshed: false, reason: 'recent-or-running' }
  try {
    const result = await textAiRefreshAutomaticCatalog()
    return { refreshed: true, ...result }
  } catch (error) {
    await db.setting.updateMany({ where: { key: 'AI_AUTO_CATALOG_CLAIM', value: String(now) }, data: { value: String(now - AI_AUTO_MAX_AGE_MS + 60_000) } })
    throw error
  }
}
