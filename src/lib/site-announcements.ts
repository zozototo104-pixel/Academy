import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/lib/db'
import { filterActiveSiteAnnouncements, parseSiteAnnouncementsValue } from '@/lib/site-announcements-core'
import type { SiteAnnouncement } from '@/lib/site-announcements-core'
export * from '@/lib/site-announcements-core'

export const SITE_ANNOUNCEMENTS_KEY = 'SITE_ANNOUNCEMENTS'
export const SITE_ANNOUNCEMENTS_CACHE_TAG = 'site-announcements'

export async function readSiteAnnouncements() {
  const row = await db.setting.findUnique({ where: { key: SITE_ANNOUNCEMENTS_KEY } })
  return parseSiteAnnouncementsValue(row?.value || '[]')
}

export async function writeSiteAnnouncements(items: SiteAnnouncement[]): Promise<void> {
  await db.setting.upsert({
    where: { key: SITE_ANNOUNCEMENTS_KEY },
    create: { key: SITE_ANNOUNCEMENTS_KEY, value: JSON.stringify(items) },
    update: { value: JSON.stringify(items) },
  })
  revalidateTag(SITE_ANNOUNCEMENTS_CACHE_TAG)
}

export const getActiveSiteAnnouncementsCached = unstable_cache(
  async () => {
    try {
      return filterActiveSiteAnnouncements(await readSiteAnnouncements())
    } catch {
      return []
    }
  },
  ['site-announcements-active'],
  { revalidate: 60, tags: [SITE_ANNOUNCEMENTS_CACHE_TAG] }
)
