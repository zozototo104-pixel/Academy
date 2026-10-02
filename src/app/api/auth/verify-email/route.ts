import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashEmailVerificationToken } from '@/lib/email-verification'
import { emailWelcome } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function appBaseUrl(req: NextRequest) {
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  if (host) return `${proto}://${host}`.replace(/\/$/, '')
  return String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://aactacademy.com').replace(/\/+$/, '')
}

function redirectAuth(req: NextRequest, params: Record<string, string>) {
  const url = new URL('/?view=auth', appBaseUrl(req))
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || ''
  if (!token || token.length < 20) return redirectAuth(req, { verify_email: 'invalid' })

  const tokenHash = hashEmailVerificationToken(token)
  const user = await db.user.findFirst({
    where: {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { gt: new Date() },
      status: 'ACTIVE',
    },
    select: { id: true, email: true, name: true, emailVerifiedAt: true },
  }).catch(() => null)

  if (!user) return redirectAuth(req, { verify_email: 'invalid_or_expired' })

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
  const response = redirectAuth(req, { email_verified: '1', email: user.email, reset_session: '1' })
  response.cookies.set('aact_session', '', { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 0 })
  return response
}
