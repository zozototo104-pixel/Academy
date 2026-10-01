import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { representativeVerifyUrl, serializeRepresentative, verifyRepresentativeLast4 } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const last4 = String(body.last4 || '').trim()
  if (last4.length < 4) return NextResponse.json({ error: 'LAST4_REQUIRED', message: 'أدخل آخر 4 أرقام من الجوال أو الإيميل.' }, { status: 400 })

  const rep = await db.academyRepresentative.findFirst({
    where: { qrToken: token, deletedAt: null, status: 'ACTIVE' },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  }).catch(() => null)

  if (!rep) return NextResponse.json({ error: 'NOT_FOUND', message: 'رمز التحقق غير صالح أو غير نشط.' }, { status: 404 })
  const ok = verifyRepresentativeLast4(last4, rep.verifyPhoneLast4Hash, rep.verifyEmailLast4Hash)
  await db.auditLog.create({
    data: {
      actorName: 'زائر تحقق QR',
      action: ok ? 'VERIFY_REPRESENTATIVE_CARD_SUCCESS' : 'VERIFY_REPRESENTATIVE_CARD_FAILED',
      entity: 'AcademyRepresentative',
      entityId: rep.id,
      details: `token=${token.slice(0, 16)}...`,
    },
  }).catch(() => {})

  if (!ok) return NextResponse.json({ error: 'INVALID_LAST4', message: 'الأرقام المدخلة لا تطابق بيانات التحقق الخاصة بالممثل.' }, { status: 403 })

  const origin = originFrom(req)
  return NextResponse.json({
    verified: true,
    representative: {
      ...serializeRepresentative(rep, origin, false),
      verifyUrl: representativeVerifyUrl(rep.qrToken, origin),
      officialCardUrl: rep.officialCardUrl,
    },
  })
}
