import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, createSession } from '@/lib/auth'
import { emailWelcome } from '@/lib/mailer'

export async function POST(req: NextRequest) {
  try {
    const { name, email, password, phone, country } = await req.json()

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

    const existing = await db.user.findUnique({ where: { email: emailNorm } })
    if (existing) {
      return NextResponse.json(
        { error: 'هذا البريد الإلكتروني مسجل مسبقاً — يمكنك تسجيل الدخول' },
        { status: 409 }
      )
    }

    const user = await db.user.create({
      data: {
        name: name.trim(),
        email: emailNorm,
        password: hashPassword(password),
        phone: phone?.trim() || null,
        country: country?.trim() || null,
        role: 'STUDENT',
      },
    })

    const token = await createSession(user.id)

    // إشعار بريدي ترحيبي (آمن: لا يعمل التسجيل فشلاً إن تعذر الإرسال)
    emailWelcome(user.email, user.name).catch(() => {})

    return NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token,
    })
  } catch (e) {
    console.error('Register error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء التسجيل، حاول مرة أخرى' }, { status: 500 })
  }
}
