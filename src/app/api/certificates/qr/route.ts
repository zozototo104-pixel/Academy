import { NextRequest, NextResponse } from 'next/server'
import QRCode from 'qrcode'

// GET /api/certificates/qr?data=... — توليد صورة QR بتنسيق Data URL
export async function GET(req: NextRequest) {
  try {
    const data = req.nextUrl.searchParams.get('data')
    if (!data) return NextResponse.json({ error: 'بيانات QR مطلوبة' }, { status: 400 })
    const url = await QRCode.toDataURL(data.slice(0, 512), {
      width: 220,
      margin: 1,
      color: { dark: '#0f2b46', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
    return NextResponse.json({ qr: url })
  } catch (e) {
    console.error('certificates qr error:', e)
    return NextResponse.json({ error: 'تعذر توليد رمز QR' }, { status: 500 })
  }
}
