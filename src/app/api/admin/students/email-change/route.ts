import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { requestEmailChange, type EmailChangePurpose } from '@/lib/email-change'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Admin-triggered email change for a student who cannot do it themselves
// (e.g. their mailbox is full and they cannot sign in). The admin only
// STARTS the flow: the change takes effect when the student confirms from
// the NEW mailbox, so a typo can never hand the account to a stranger.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin().catch(() => null)
  if (!admin) return NextResponse.json({ error: 'صلاحيات غير كافية.' }, { status: 403 })

  const body = await req.json().catch(() => ({} as any))
  const userId = String(body?.userId || '')
  if (!userId) return NextResponse.json({ error: 'اختر الطالب أولاً.' }, { status: 400 })
  const purpose: EmailChangePurpose = body?.purpose === 'LOGIN' ? 'LOGIN' : 'NOTIFICATION'

  const user = await db.user.findUnique({ where: { id: userId } }).catch(() => null)
  if (!user) return NextResponse.json({ error: 'الحساب غير موجود.' }, { status: 404 })
  if (user.role === 'ADMIN') return NextResponse.json({ error: 'لا يمكن تغيير بريد حساب إداري من هنا.' }, { status: 400 })

  const result = await requestEmailChange({
    req,
    user: user as any,
    newEmail: String(body?.newEmail || ''),
    purpose,
    requestedBy: { id: admin.id, name: admin.name },
  })
  if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status })
  return NextResponse.json({ ok: true, pendingEmail: String(body.newEmail).toLowerCase().trim(), purpose })
}
