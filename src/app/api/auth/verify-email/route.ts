import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashEmailVerificationToken } from '@/lib/email-verification'
import { applyPendingEmailChange } from '@/lib/email-change'
import { emailEmailChangeNotice, emailWelcome } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function appBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (!configured) throw new Error('NEXT_PUBLIC_APP_URL is required for email verification redirects')
  return configured.replace(/\/+$/, '')
}

function redirectAuth(params: Record<string, string>) {
  const url = new URL('/?view=auth', appBaseUrl())
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || ''
  if (!token || token.length < 20) return redirectAuth({ verify_email: 'invalid' })

  const tokenHash = hashEmailVerificationToken(token)
  const user = await db.user.findFirst({
    where: {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { gt: new Date() },
      status: 'ACTIVE',
    },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, pendingEmail: true, pendingEmailPurpose: true } as any,
  }).catch(() => null) as null | { id: string; email: string; name: string; emailVerifiedAt: Date | null; pendingEmail?: string | null; pendingEmailPurpose?: string | null }

  if (!user) return redirectAuth({ verify_email: 'invalid_or_expired' })

  // A pending email change rides on the same token: confirming from the new
  // mailbox applies the change instead of a plain registration verification.
  if (user.pendingEmail) {
    const applied = await applyPendingEmailChange(user)
    if (applied.outcome === 'EMAIL_TAKEN') return redirectAuth({ verify_email: 'email_taken' })
    if (applied.outcome === 'LOGIN_APPLIED') {
      emailEmailChangeNotice(applied.oldEmail, user.name, `تم تغيير بريد الدخول إلى حسابك إلى ${applied.newEmail}. إذا لم تطلب هذا التغيير، تواصل مع إدارة الأكاديمية فوراً.`).catch(() => {})
      const response = redirectAuth({ email_verified: '1', email: applied.newEmail, reset_session: '1' })
      response.cookies.set('aact_session', '', { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0 })
      return response
    }
    emailEmailChangeNotice(user.email, user.name, `تم اعتماد بريد الإشعارات ${applied.newEmail} لحسابك — ستصل إشعارات المنصة إليه من الآن.`).catch(() => {})
    return redirectAuth({ notification_email: '1', email: user.email })
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: user.emailVerifiedAt || new Date(),
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
      emailVerificationSentAt: null,
    },
  })

  if (!user.emailVerifiedAt) emailWelcome(user.email, user.name).catch(() => {})
  const response = redirectAuth({ email_verified: '1', email: user.email, reset_session: '1' })
  response.cookies.set('aact_session', '', { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0 })
  return response
}
