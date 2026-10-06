import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { verifyPaymentWaiverCode } from '@/lib/payment-waivers'

function cleanText(value: unknown, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => ({}))
    const paymentId = cleanText(body.paymentId, 80)
    const code = cleanText(body.code, 80).toUpperCase()
    if (!paymentId || !code) return NextResponse.json({ error: 'الفاتورة وكود الإعفاء مطلوبان' }, { status: 400 })
    const waiver = await verifyPaymentWaiverCode({ paymentId, code, user: { id: user.id, email: user.email, name: user.name, emailVerifiedAt: (user as any).emailVerifiedAt || null } as any })
    return NextResponse.json({ waiver, message: 'تم التحقق من كود الإعفاء. بانتظار اعتماد الإدارة النهائي.' })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    return NextResponse.json({ error: e?.message || 'تعذر التحقق من كود الإعفاء' }, { status: 400 })
  }
}
