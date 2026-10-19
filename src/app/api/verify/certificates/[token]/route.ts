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

    if (clean === '__route_probe__') {
      return new NextResponse(
        JSON.stringify({
          ok: true,
          route: 'w3c-certificate-verification',
          probe: true,
          '@context': ['https://www.w3.org/2018/credentials/v1'],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/ld+json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      )
    }

    const limited = enforceApiRateLimit(req, 'w3c:certificate', 60, 10 * 60 * 1000, clean)
    if (limited) return limited

    const cert = await db.certificate.findFirst({
      where: { OR: [{ qrToken: clean }, { serial: clean }, { legacySerial: clean }] },
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
        revokedAt: true,
        revokedReason: true,
        userId: true,
        enrollmentId: true,
        admissionId: true,
        agentId: true,
      },
    })

    if (!cert) {
      return NextResponse.json({ valid: false, error: 'الشهادة غير موجودة أو رمز التحقق غير صحيح' }, { status: 404 })
    }

    const revokedAt = cert.revokedAt ? new Date(cert.revokedAt).toISOString() : null
    const effectiveValid = cert.valid && !revokedAt
    const credential = buildCertificateCredential({ ...cert, valid: effectiveValid })
    return new NextResponse(
      JSON.stringify({
        valid: effectiveValid,
        statusLabel: effectiveValid ? 'سارية' : `ملغاة${revokedAt ? ` بتاريخ ${revokedAt.slice(0, 10)}` : ''}`,
        revokedAt,
        revokedReason: cert.revokedReason || null,
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
