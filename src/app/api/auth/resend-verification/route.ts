import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkDatabaseRateLimit, clientIpFromHeaders, rateLimitHeaders } from '@/lib/rate-limit'
import { issueEmailVerificationToken, emailVerificationUrl, shouldRequireEmailVerification, shouldIssueNewVerification } from '@/lib/email-verification'
import { emailVerifyAccount } from '@/lib/mailer'

function genericResponse() {
  return NextResponse.json({ ok: true, message: 'إذا كان البريد مسجلاً ستصلك رسالة خلال دقائق' })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    if (!email) return NextResponse.json({ error: 'البريد الإلكتروني مطلوب' }, { status: 400 })
    const ip = clientIpFromHeaders(req.headers)
    const ipLimit = await checkDatabaseRateLimit(`auth:resend-verification:ip:${ip}`, 8, 60 * 60 * 1000)
    const emailLimit = await checkDatabaseRateLimit(`auth:resend-verification:email:${email}`, 3, 60 * 60 * 1000)
    if (!ipLimit.ok || !emailLimit.ok) {
      const limited = !emailLimit.ok ? emailLimit : ipLimit
      return NextResponse.json({ error: 'طلبات كثيرة لإعادة إرسال رابط التأكيد. انتظر قليلاً ثم حاول مرة أخرى.' }, { status: 429, headers: rateLimitHeaders(limited) })
    }

    const user = await db.user.findUnique({ where: { email } })
    if (!user) return NextResponse.json({ ok: true, sent: false })
    if (!shouldRequireEmailVerification(user)) return NextResponse.json({ ok: true, alreadyVerified: true })
    if (!shouldIssueNewVerification(user)) {
      return NextResponse.json({ ok: true, sent: false, message: 'تم إرسال رابط تأكيد حديثاً. افحص بريدك أو انتظر قليلاً قبل طلب رابط جديد.' })
    }
    const verification = await issueEmailVerificationToken(user.id)
    const sent = await emailVerifyAccount(user.email, user.name, emailVerificationUrl(req, verification.token)).catch(() => false)
    return NextResponse.json({ ok: true, sent })
  } catch (error) {
    console.error('resend verification error:', error)
    return NextResponse.json({ error: 'تعذر إعادة إرسال رابط التأكيد' }, { status: 500 })
  }
}
