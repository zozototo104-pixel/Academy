import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { representativeVerifyUrl } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const representative = await db.academyRepresentative.findFirst({
    where: { qrToken: token, deletedAt: null },
    select: { id: true, status: true },
  }).catch(() => null)

  if (!representative || representative.status === 'ARCHIVED') {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  const url = new URL(req.url)
  const verifyUrl = representativeVerifyUrl(token, `${url.protocol}//${url.host}`)
  const png = await QRCode.toBuffer(verifyUrl, {
    type: 'png',
    width: 720,
    margin: 2,
    color: { dark: '#0f2b46', light: '#ffffff' },
  })

  return new NextResponse(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Disposition': `inline; filename="aact-representative-${representative.id}.png"`,
    },
  })
}
