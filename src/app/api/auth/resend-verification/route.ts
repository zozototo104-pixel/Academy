import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkDatabaseRateLimit, clientIpFromHeaders } from '@/lib/rate-limit'
import { issueEmailVerificationToken, emailVerificationUrl, shouldRequireEmailVerification, shouldIssueNewVerification } from '@/lib/email-verification'
import { emailVerifyAccount } from '@/lib/mailer'

function genericResponse() {
  return NextResponse.json({ ok: true, message: 'إذا كان البريد مسجلاً ستصلك رسالة خلال دقائق' })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    if (!email) return genericResponse()
    const ip = clientIpFromHeaders(req.headers)
    const ipLimit = await checkDatabaseRateLimit(`auth:resend-verification:ip:${ip}`, 8, 60 * 60 * 1000)
    const emailLimit = await checkDatabaseRateLimit(`auth:resend-verification:email:${email}`, 3, 60 * 60 * 1000)
    if (!ipLimit.ok || !emailLimit.ok) return genericResponse()

    const user = await db.user.findUnique({ where: { email } })
    if (!user) return genericResponse()
    if (!shouldRequireEmailVerification(user)) return genericResponse()
    if (!shouldIssueNewVerification(user)) return genericResponse()
    const verification = await issueEmailVerificationToken(user.id)
    await emailVerifyAccount(user.email, user.name, emailVerificationUrl(req, verification.token)).catch(() => false)
    return genericResponse()
  } catch (error) {
    console.error('resend verification error:', error)
    return genericResponse()
  }
}
