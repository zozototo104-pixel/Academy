import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, createSession } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { ensureDemoThesisStudent, DEMO_THESIS_STUDENT_EMAIL, DEMO_THESIS_STUDENT_PASSWORD } from '@/lib/demo-thesis'

export async function POST(req: NextRequest) {
  try {
    await ensureCoreSeed()
    const { email, password } = await req.json()
    if (!email?.trim() || !password) {
      return NextResponse.json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()
    if (normalizedEmail === DEMO_THESIS_STUDENT_EMAIL && password === DEMO_THESIS_STUDENT_PASSWORD) {
      // يجهّز حساب الطالب التجريبي تلقائياً عند أول محاولة دخول، حتى لو لم يظهر زر الإدارة بسبب تأخر الـ Deploy السابق.
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
