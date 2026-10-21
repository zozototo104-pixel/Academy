import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  canManageSiteAnnouncements,
  readSiteAnnouncements,
  validateAnnouncementInput,
  writeSiteAnnouncements,
} from '@/lib/site-announcements'

async function requireAnnouncementAdmin() {
  const user = await getCurrentUser()
  if (!user) return { user: null, error: NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 }) }
  if (!canManageSiteAnnouncements(user)) return { user: null, error: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) }
  return { user, error: null }
}

function jsonError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : 'تعذر تنفيذ العملية'
  return NextResponse.json({ error: message }, { status })
}

export async function GET() {
  try {
    const auth = await requireAnnouncementAdmin()
    if (auth.error || !auth.user) return auth.error || NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    const announcements = await readSiteAnnouncements()
    return NextResponse.json({ announcements })
  } catch (error) {
    return jsonError(error, 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAnnouncementAdmin()
    if (auth.error || !auth.user) return auth.error || NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    const body = await req.json()
    const announcements = await readSiteAnnouncements()
    const next = validateAnnouncementInput(body)
    await writeSiteAnnouncements([next, ...announcements])
    await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', next.id, `إنشاء إعلان: ${next.title}`)
    return NextResponse.json({ announcement: next })
  } catch (error) {
    return jsonError(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAnnouncementAdmin()
    if (auth.error) return auth.error
    const body = await req.json()
    const id = String(body?.id || '').trim()
    if (!id) return NextResponse.json({ error: 'معرّف الإعلان مطلوب' }, { status: 400 })
    const announcements = await readSiteAnnouncements()
    const index = announcements.findIndex((item) => item.id === id)
    if (index < 0) return NextResponse.json({ error: 'الإعلان غير موجود' }, { status: 404 })
    const updated = validateAnnouncementInput(body, announcements[index])
    const next = announcements.slice()
    next[index] = updated
    await writeSiteAnnouncements(next)
    await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', updated.id, `تعديل إعلان: ${updated.title}`)
    return NextResponse.json({ announcement: updated })
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAnnouncementAdmin()
    if (auth.error) return auth.error
    const url = new URL(req.url)
    const id = String(url.searchParams.get('id') || '').trim()
    if (!id) return NextResponse.json({ error: 'معرّف الإعلان مطلوب' }, { status: 400 })
    const announcements = await readSiteAnnouncements()
    const target = announcements.find((item) => item.id === id)
    if (!target) return NextResponse.json({ error: 'الإعلان غير موجود' }, { status: 404 })
    await writeSiteAnnouncements(announcements.filter((item) => item.id !== id))
    await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', id, `حذف إعلان: ${target.title}`)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
