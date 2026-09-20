import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, createSession } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { ensureDemoThesisStudent, DEMO_THESIS_STUDENT_EMAIL, DEMO_THESIS_STUDENT_PASSWORD } from '@/lib/demo-thesis'
import { checkRateLimit, clientIpFromHeaders, rateLimitHeaders } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  try {
    const shouldAutoSeedOnLogin = process.env.AACT_AUTO_SEED_ON_LOGIN === '1' || process.env.NODE_ENV !== 'production'
    if (shouldAutoSeedOnLogin) {
      // في الإنتاج لا نشغل seed تلقائياً مع كل تسجيل دخول إلا إذا فُعّل صراحةً عبر AACT_AUTO_SEED_ON_LOGIN=1.
      void ensureCoreSeed().catch((err) => console.error('Background core seed error:', err))
    }

    const { email, password } = await req.json()
    if (!email?.trim() || !password) {
      return NextResponse.json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const ip = clientIpFromHeaders(req.headers)
    const ipLimit = checkRateLimit(`login:ip:${ip}`, 40, 15 * 60 * 1000)
    const accountLimit = checkRateLimit(`login:account:${normalizedEmail}:${ip}`, 8, 15 * 60 * 1000)
    if (!ipLimit.ok || !accountLimit.ok) {
      const limited = !accountLimit.ok ? accountLimit : ipLimit
      return NextResponse.json(
        { error: 'محاولات تسجيل دخول كثيرة. انتظر قليلاً ثم حاول مرة أخرى.' },
        { status: 429, headers: rateLimitHeaders(limited) }
      )
    }

    const demoLoginEnabled = process.env.AACT_ENABLE_DEMO_LOGIN === '1' || process.env.NODE_ENV !== 'production'
    if (demoLoginEnabled && normalizedEmail === DEMO_THESIS_STUDENT_EMAIL && password === DEMO_THESIS_STUDENT_PASSWORD) {
      // يجهّز حساب الطالب التجريبي فقط في البيئات التجريبية أو عند تفعيله صراحةً.
      await ensureCoreSeed(true).catch((err) => console.error('Auto demo seed error:', err))
      await ensureDemoThesisStudent({ resetDefense: true, actor: null }).catch((err) => console.error('Auto demo thesis setup error:', err))
    }

    const user = await db.user.findUnique({ where: { email: normalizedEmail } })
    if (!user || !verifyPassword(password, user.password)) {
      return NextResponse.json({ error: 'بيانات الدخول غير صحيحة' }, { status: 401 })
    }

    const token = await createSession(user.id)

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token,
    })
  } catch (e) {
    console.error('Login error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء تسجيل الدخول' }, { status: 500 })
  }
}
