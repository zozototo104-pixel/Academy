import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { nextInvoiceNo } from '@/lib/settings'

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function envAmount(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : fallback
}

// POST /api/ai/gemini-live/package — إنشاء فاتورة باقة دقائق صوت إضافية
export async function POST() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })

    const minutes = envNum('AACT_LIVE_PACKAGE_MINUTES', 60)
    const amount = envAmount('AACT_LIVE_PACKAGE_PRICE_USD', 10)
    const description = `باقة دقائق صوت Gemini Live — ${minutes} دقيقة`

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
        currency: 'USD',
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
