import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { buildCertificateCredential, certificateVerificationUrl, verifyCertificateCredential } from '@/lib/w3c/certificate-credential'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> | { token: string } }

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { token } = await Promise.resolve(context.params)
    const clean = decodeURIComponent(token || '').trim()
    if (!clean) return NextResponse.json({ error: 'رمز التحقق مطلوب' }, { status: 400 })

    const limited = enforceApiRateLimit(req, 'w3c:certificate', 60, 10 * 60 * 1000, clean)
    if (limited) return limited

    const cert = await db.certificate.findFirst({
      where: { OR: [{ qrToken: clean }, { serial: clean }] },
      select: {
        id: true,
        serial: true,
        qrToken: true,
        type: true,
        holderName: true,
        program: true,
        grade: true,
        country: true,
        issuedAt: true,
        valid: true,
        userId: true,
        enrollmentId: true,
        admissionId: true,
        agentId: true,
      },
    })

    if (!cert) {
      return NextResponse.json({ valid: false, error: 'الشهادة غير موجودة أو رمز التحقق غير صحيح' }, { status: 404 })
    }

    const credential = buildCertificateCredential(cert)
    return new NextResponse(
      JSON.stringify({
        valid: cert.valid,
        proofVerified: verifyCertificateCredential(credential),
        verificationUrl: certificateVerificationUrl(cert),
        credential,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/ld+json; charset=utf-8',
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        },
      }
    )
  } catch (e) {
    console.error('W3C certificate credential error:', e)
    return NextResponse.json({ error: 'تعذر توليد بيانات الشهادة القابلة للتحقق' }, { status: 500 })
  }
}
