import { NextResponse } from 'next/server'
import { getActiveSiteAnnouncementsCached } from '@/lib/site-announcements'

export async function GET() {
  try {
    const announcements = await getActiveSiteAnnouncementsCached()
    return NextResponse.json({ announcements })
  } catch {
    return NextResponse.json({ announcements: [] })
  }
}
