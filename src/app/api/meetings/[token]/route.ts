import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { findMeetingInviteByToken } from '@/lib/admin-meetings'
import { meetingAction, meetingState } from '@/lib/meeting-entry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// بوابة رابط الدعوة: الرمز هو الاعتماد الخارجي؛ هاشه فقط في القاعدة.
// الزائر بلا حساب يرى تمهيدًا (عنوان + موعد) فقط — التفاصيل بعد
// تسجيل الدخول واستلام الدعوة بالحساب.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await findMeetingInviteByToken(db as any, token)
  if (!invite) return NextResponse.json({ ok: true, level: 'NONE', problem: 'NOT_FOUND' })
  const user = await getCurrentUser().catch(() => null)
  const res = await meetingState(db as any, invite, user as any)
  return NextResponse.json(res.body, { status: res.status })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await findMeetingInviteByToken(db as any, token)
  if (!invite) return NextResponse.json({ error: 'رابط الدعوة غير صالح', code: 'NOT_FOUND' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const user = await getCurrentUser().catch(() => null)
  const res = await meetingAction(db as any, invite, user as any, String(body?.action || ''), body || {})
  return NextResponse.json(res.body, { status: res.status })
}
