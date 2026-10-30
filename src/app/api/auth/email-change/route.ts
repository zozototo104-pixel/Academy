import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { cancelPendingEmailChange, requestEmailChange, type EmailChangePurpose } from '@/lib/email-change'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A signed-in user asks to change their login email (password accounts) or
// to set a notification email (any account, the only flow for Google
// accounts). Nothing changes until the confirmation link sent to the NEW
// mailbox is clicked (handled by /api/auth/verify-email).
export async function POST(req: NextRequest) {
  const sessionUser = await getCurrentUser().catch(() => null)
  if (!sessionUser) return NextResponse.json({ error: 'سجل الدخول أولاً.' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const purpose: EmailChangePurpose = body?.purpose === 'LOGIN' ? 'LOGIN' : 'NOTIFICATION'

  const user = await db.user.findUnique({ where: { id: sessionUser.id } }).catch(() => null)
  if (!user) return NextResponse.json({ error: 'الحساب غير موجود.' }, { status: 404 })

  const result = await requestEmailChange({
    req,
    user: user as any,
    newEmail: String(body?.newEmail || ''),
    purpose,
    password: body?.password ? String(body.password) : undefined,
  })
  if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status })
  return NextResponse.json({ ok: true, pendingEmail: String(body.newEmail).toLowerCase().trim(), purpose })
}

// Cancel a pending (unconfirmed) email change.
export async function DELETE() {
  const sessionUser = await getCurrentUser().catch(() => null)
  if (!sessionUser) return NextResponse.json({ error: 'سجل الدخول أولاً.' }, { status: 401 })
  await cancelPendingEmailChange(sessionUser.id)
  return NextResponse.json({ ok: true })
}
