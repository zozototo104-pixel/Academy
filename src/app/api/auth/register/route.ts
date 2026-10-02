import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { emailVerifyAccount } from '@/lib/mailer'
import { createEmailVerificationToken, emailVerificationUrl } from '@/lib/email-verification'
import { checkRateLimit, clientIpFromHeaders, rateLimitHeaders } from '@/lib/rate-limit'

function sameSiteRequest(req: NextRequest) {
  const host = req.headers.get('host') || ''
  const origin = req.headers.get('origin') || ''
  const referer = req.headers.get('referer') || ''
  const allowed = (value: string) => {
    if (!value) return true
    try {
      return new URL(value).host === host
    } catch {
      return false
    }
  }
  return allowed(origin) && allowed(referer)
}

function normalizeOptionalText(value: unknown, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export async function POST(req: NextRequest) {
  try {
    if (!sameSiteRequest(req)) {
      return NextResponse.json({ error: 'تعذر قبول طلب التسجيل من هذا المصدر.' }, { status: 403 })
    }
    if (req.headers.get('x-aact-register-form') !== 'web') {
      return NextResponse.json({ error: 'تعذر قبول طلب التسجيل من هذا النموذج.' }, { status: 403 })
    }

    const ip = clientIpFromHeaders(req.headers)
    const ipLimit = checkRateLimit(`auth:register:ip:${ip}`, 4, 15 * 60 * 1000)
    if (!ipLimit.ok) {
      return NextResponse.json(
        { error: 'محاولات إنشاء حسابات كثيرة من نفس المصدر. انتظر قليلاً ثم حاول مرة أخرى.' },
        { status: 429, headers: rateLimitHeaders(ipLimit) }
      )
    }

    const body = await req.json().catch(() => ({}))
    const { name, email, password, phone, country } = body
    const honeypot = normalizeOptionalText(body.website || body.company || body.homepage, 160)
    if (honeypot) {
      return NextResponse.json({ error: 'تعذر معالجة طلب التسجيل.' }, { status: 400 })
    }

    if (!name?.trim() || !email?.trim() || !password) {
      return NextResponse.json(
        { error: 'الاسم والبريد الإلكتروني وكلمة المرور مطلوبة' },
        { status: 400 }
      )
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' },
        { status: 400 }
      )
    }
    const emailNorm = email.trim().toLowerCase()
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRe.test(emailNorm)) {
      return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    }

    const emailLimit = checkRateLimit(`auth:register:email:${emailNorm}`, 2, 60 * 60 * 1000)
    if (!emailLimit.ok) {
      return NextResponse.json(
        { error: 'تم إرسال طلبات كثيرة لهذا البريد. انتظر قليلاً ثم حاول مرة أخرى.' },
        { status: 429, headers: rateLimitHeaders(emailLimit) }
      )
    }

    const existing = await db.user.findUnique({ where: { email: emailNorm } })
    if (existing) {
      return NextResponse.json(
        { error: 'هذا البريد الإلكتروني مسجل مسبقاً — يمكنك تسجيل الدخول' },
        { status: 409 }
      )
    }

    const verification = createEmailVerificationToken()
    const user = await db.user.create({
      data: {
        name: normalizeOptionalText(name, 120),
        email: emailNorm,
        password: hashPassword(password),
        phone: normalizeOptionalText(phone, 40) || null,
        country: normalizeOptionalText(country, 80) || null,
        role: 'STUDENT',
        emailVerificationTokenHash: verification.tokenHash,
        emailVerificationExpiresAt: verification.expiresAt,
        emailVerificationSentAt: new Date(),
      },
    })

    const verificationSent = await emailVerifyAccount(user.email, user.name, emailVerificationUrl(req, verification.token)).then(() => true).catch(() => false)

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      requiresEmailVerification: true,
      verificationEmailSent: verificationSent,
      message: verificationSent
        ? 'تم إنشاء الحساب. أرسلنا لك رابط تأكيد البريد الإلكتروني.'
        : 'تم إنشاء الحساب، لكن تعذر إرسال بريد التأكيد. تواصل مع الإدارة أو جرّب تسجيل الدخول لاحقاً لإعادة الإرسال.',
    })
  } catch (e) {
    console.error('Register error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء التسجيل، حاول مرة أخرى' }, { status: 500 })
  }
}
