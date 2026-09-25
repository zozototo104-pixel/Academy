import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { getSettingNum, nextInvoiceNo } from '@/lib/settings'

async function getLiveVoicePackage() {
  const minutesRaw = await getSettingNum('AI_LIVE_PACKAGE_MINUTES')
  const amountRaw = await getSettingNum('AI_LIVE_PACKAGE_PRICE_USD')
  const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.floor(minutesRaw) : 60
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? Math.round(amountRaw * 100) / 100 : 10
  return { minutes, amount, currency: 'USD' }
}

// GET /api/ai/gemini-live/package — عرض باقة دقائق الصوت الحالية كما حددتها الإدارة
export async function GET() {
  try {
    const offer = await getLiveVoicePackage()
    return NextResponse.json({ ok: true, ...offer })
  } catch (e) {
    console.error('live package offer error:', e)
    return NextResponse.json({ error: 'تعذر تحميل باقة الصوت' }, { status: 500 })
  }
}

// POST /api/ai/gemini-live/package — إنشاء فاتورة باقة دقائق صوت إضافية من داخل المنصة
export async function POST() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })

    const { minutes, amount, currency } = await getLiveVoicePackage()
    const description = `باقة دقائق صوت للمشرف الذكي — ${minutes} دقيقة`

    const existing = await db.payment.findFirst({
      where: {
        userId: user.id,
        purpose: 'AI_LIVE_CREDIT',
        status: 'UNPAID',
        description,
      },
      orderBy: { createdAt: 'desc' },
    })

    if (existing) {
      return NextResponse.json({
        ok: true,
        invoiceNo: existing.invoiceNo,
        minutes,
        amount: existing.amount,
        currency: existing.currency,
        reused: true,
      })
    }

    const invoiceNo = await nextInvoiceNo()
    const payment = await db.payment.create({
      data: {
        userId: user.id,
        invoiceNo,
        purpose: 'AI_LIVE_CREDIT',
        description,
        amount,
        currency,
        status: 'UNPAID',
        payerName: user.name,
        payerEmail: user.email,
      },
    })

    return NextResponse.json({
      ok: true,
      invoiceNo: payment.invoiceNo,
      minutes,
      amount: payment.amount,
      currency: payment.currency,
      reused: false,
    })
  } catch (e) {
    console.error('live package invoice error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء فاتورة باقة الصوت' }, { status: 500 })
  }
}
