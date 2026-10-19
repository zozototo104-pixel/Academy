import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { NextRequest } from 'next/server'

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

export function hashPasswordResetToken(token: string) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

export function createPasswordResetToken(ttlMs = PASSWORD_RESET_TTL_MS) {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  }
}

export function passwordResetUrl(_req: NextRequest, token: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (!configured) throw new Error('NEXT_PUBLIC_APP_URL is required to build password reset URLs')
  const base = configured.replace(/\/+$/, '')
  const url = new URL('/reset-password', base)
  url.searchParams.set('token', token)
  return url.toString()
}

export function safePasswordResetTokenEquals(token: string, storedHash: string) {
  const aa = Buffer.from(hashPasswordResetToken(token), 'hex')
  const bb = Buffer.from(String(storedHash || ''), 'hex')
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
