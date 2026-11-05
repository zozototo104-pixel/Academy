import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { meetingAction, meetingState } from '@/lib/meeting-entry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// دخول بالحساب بعد استلام الدعوة: الحق مشتق من صف الدعوة المستلَمة
// (claimedByUserId = المستخدم الحالي) لا من الرمز ولا من الدور.
async function resolve(req: NextRequest, inviteId: string) {
  const user = await getCurrentUser().catch(() => null)
  if (!user) return { user: null, invite: null }
  const invite = await (db as any).adminMeetingInvite.findUnique({
    where: { id: inviteId },
    include: { meeting: true },
  }).catch(() => null)
  if (!invite || (invite.claimedByUserId !== user.id && user.role !== 'ADMIN')) return { user, invite: null }
  return { user, invite }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ inviteId: string }> }) {
  const { inviteId } = await params
  const { user, invite } = await resolve(req, inviteId)
  if (!invite) return NextResponse.json({ ok: true, level: 'NONE', problem: 'NOT_FOUND' })
  const res = await meetingState(db as any, invite, user as any)
  return NextResponse.json(res.body, { status: res.status })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ inviteId: string }> }) {
  const { inviteId } = await params
  const { user, invite } = await resolve(req, inviteId)
  if (!invite) return NextResponse.json({ error: 'الدعوة غير موجودة لهذا الحساب', code: 'NOT_FOUND' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const res = await meetingAction(db as any, invite, user as any, String(body?.action || ''), body || {})
  return NextResponse.json(res.body, { status: res.status })
}
