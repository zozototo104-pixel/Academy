import { NextRequest, NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { enforceApiRateLimit } from '@/lib/rate-limit'

// GET /api/certificates/qr?data=... — توليد صورة QR بتنسيق Data URL
export async function GET(req: NextRequest) {
  try {
    const data = req.nextUrl.searchParams.get('data')
    const qrLimit = enforceApiRateLimit(req, 'certificates:qr', 60, 10 * 60 * 1000, data?.slice(0, 120) || 'empty')
    if (qrLimit) return qrLimit

    if (!data) return NextResponse.json({ error: 'بيانات QR مطلوبة' }, { status: 400 })
    const width = req.nextUrl.searchParams.get('download') === '1' || req.nextUrl.searchParams.get('size') === '1024' ? 1024 : 512
    const url = await QRCode.toDataURL(data.slice(0, 512), {
      width,
      margin: 4,
      color: { dark: '#0f2b46', light: '#FFFFFF' },
      errorCorrectionLevel: 'M',
    })
    return NextResponse.json({ qr: url })
  } catch (e) {
    console.error('certificates qr error:', e)
    return NextResponse.json({ error: 'تعذر توليد رمز QR' }, { status: 500 })
  }
}
