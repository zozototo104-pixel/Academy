import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkDatabaseRateLimit, clientIpFromHeaders } from '@/lib/rate-limit'
import { createPasswordResetToken, passwordResetUrl } from '@/lib/password-reset'
import { emailPasswordReset } from '@/lib/mailer'

function genericResponse(_sent?: boolean) {
  return NextResponse.json({ ok: true, message: 'إذا كان البريد مسجلاً ستصلك رسالة خلال دقائق' })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    if (!email) return genericResponse(false)
    const ip = clientIpFromHeaders(req.headers)
    const ipLimit = await checkDatabaseRateLimit(`auth:forgot-password:ip:${ip}`, 10, 60 * 60 * 1000)
    const emailLimit = await checkDatabaseRateLimit(`auth:forgot-password:email:${email}`, 3, 60 * 60 * 1000)
    if (!ipLimit.ok || !emailLimit.ok) return genericResponse(false)

    const user = await db.user.findUnique({ where: { email } })
    if (!user || user.status !== 'ACTIVE') return genericResponse(false)

    const token = createPasswordResetToken()
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: token.tokenHash,
        passwordResetExpiresAt: token.expiresAt,
        passwordResetUsedAt: null,
      },
    })
    const sent = await emailPasswordReset(user.email, user.name, passwordResetUrl(req, token.token)).catch(() => false)
    return genericResponse(sent)
  } catch (error) {
    console.error('forgot password error:', error)
    return genericResponse(false)
  }
}
