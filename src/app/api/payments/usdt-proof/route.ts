import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST() {
  return NextResponse.json(
    {
      error: 'هذا المسار القديم لإثبات USDT تم إيقافه. استخدم المسار الموحد /api/payments/usdt/verify حتى يتم فحص التكرار والتحقق من الشبكة والمبلغ.',
      replacement: '/api/payments/usdt/verify',
    },
    { status: 410 },
  )
}
