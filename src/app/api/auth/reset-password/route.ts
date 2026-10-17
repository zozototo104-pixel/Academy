import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { hashPasswordResetToken, safePasswordResetTokenEquals } from '@/lib/password-reset'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const token = String(body.token || '').trim()
    const password = String(body.password || '')
    if (!token || !password) return NextResponse.json({ error: 'رمز إعادة التعيين وكلمة المرور الجديدة مطلوبان' }, { status: 400 })
    if (password.length < 6) return NextResponse.json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, { status: 400 })

    const tokenHash = hashPasswordResetToken(token)
    const user = await db.user.findFirst({
      where: { passwordResetTokenHash: tokenHash, passwordResetUsedAt: null, passwordResetExpiresAt: { gt: new Date() }, status: 'ACTIVE' },
    })
    if (!user || !safePasswordResetTokenEquals(token, user.passwordResetTokenHash || '')) {
      return NextResponse.json({ error: 'رابط إعادة تعيين كلمة المرور غير صالح أو انتهت صلاحيته' }, { status: 400 })
    }

    await db.$transaction([
      db.user.update({
        where: { id: user.id },
        data: {
          password: hashPassword(password),
          passwordResetUsedAt: new Date(),
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      }),
      db.session.deleteMany({ where: { userId: user.id } }),
    ])

    return NextResponse.json({ ok: true, message: 'تم تحديث كلمة المرور. سجّل الدخول بكلمة المرور الجديدة.' })
  } catch (error) {
    console.error('reset password error:', error)
    return NextResponse.json({ error: 'تعذر تحديث كلمة المرور' }, { status: 500 })
  }
}
