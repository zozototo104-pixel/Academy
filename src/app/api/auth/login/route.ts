import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email?.trim() || !password) {
      return NextResponse.json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const [{ db }, { verifyPassword, createSession }, { checkRateLimit, clientIpFromHeaders, rateLimitHeaders }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/auth'),
      import('@/lib/rate-limit'),
    ])

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

    const user = await db.user.findUnique({ where: { email: normalizedEmail } })
    if (!user || !verifyPassword(password, user.password)) {
      return NextResponse.json({ error: 'بيانات الدخول غير صحيحة' }, { status: 401 })
    }

    if ((user as any).status === 'DISABLED' || (user as any).status === 'ARCHIVED') {
      return NextResponse.json({ error: 'تم تعطيل هذا الحساب. يرجى التواصل مع الإدارة.' }, { status: 403 })
    }

    const token = await createSession(user.id)

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token,
    })
  } catch (e: any) {
    console.error('Login error:', e)
    return NextResponse.json(
      {
        error: 'حدث خطأ أثناء تسجيل الدخول',
        code: 'LOGIN_ROUTE_ERROR',
        detail: process.env.NODE_ENV === 'production' ? undefined : e?.message || String(e),
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
