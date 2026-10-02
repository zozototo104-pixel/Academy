import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
export const EMAIL_VERIFICATION_RESEND_MS = 10 * 60 * 1000

export function hashEmailVerificationToken(token: string) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

export function createEmailVerificationToken() {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashEmailVerificationToken(token),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
  }
}

export function emailVerificationUrl(req: NextRequest, token: string) {
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const base = host
    ? `${proto}://${host}`
    : String(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://aactacademy.com').replace(/\/+$/, '')
  const url = new URL('/api/auth/verify-email', base)
  url.searchParams.set('token', token)
  return url.toString()
}

export function shouldRequireEmailVerification(user: { role?: string | null; emailVerifiedAt?: Date | string | null }) {
  return String(user.role || 'STUDENT') === 'STUDENT' && !user.emailVerifiedAt
}

export function shouldIssueNewVerification(user: { emailVerificationSentAt?: Date | string | null; emailVerificationExpiresAt?: Date | string | null }) {
  const sentAt = user.emailVerificationSentAt ? new Date(user.emailVerificationSentAt).getTime() : 0
  const expiresAt = user.emailVerificationExpiresAt ? new Date(user.emailVerificationExpiresAt).getTime() : 0
  return !sentAt || !expiresAt || Date.now() - sentAt > EMAIL_VERIFICATION_RESEND_MS || expiresAt <= Date.now()
}

export async function issueEmailVerificationToken(userId: string) {
  const token = createEmailVerificationToken()
  await db.user.update({
    where: { id: userId },
    data: {
      emailVerificationTokenHash: token.tokenHash,
      emailVerificationExpiresAt: token.expiresAt,
      emailVerificationSentAt: new Date(),
    },
  })
  return token
}

export function safeTokenHashEquals(a: string, b: string) {
  const aa = Buffer.from(hashEmailVerificationToken(a), 'hex')
  const bb = Buffer.from(String(b || ''), 'hex')
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
