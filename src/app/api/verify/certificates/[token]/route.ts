import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { displayedCertificateSerial } from '@/lib/legacy-certificate-files'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { buildCertificateCredential, certificateSerialVerificationUrl, certificateVerificationUrl, resolveCertificateAccessMode, verifyCertificateCredential } from '@/lib/w3c/certificate-credential'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> | { token: string } }

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const { token } = await Promise.resolve(context.params)
    const clean = decodeURIComponent(token || '').trim()
    if (!clean) return NextResponse.json({ error: 'رمز التحقق مطلوب' }, { status: 400 })

    if (req.headers.get('accept')?.includes('text/html')) {
      return NextResponse.redirect(certificateVerificationUrl({ qrToken: clean }), 307)
    }

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
        legacySerial: true,
        qrPosition: true,
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
    // البحث بالرقم التسلسلي/القديم (قابل للتخمين) لا يكشف qrToken ولا التقدير
    // داخل الاعتماد ولا في روابطه — نفس سياسة الإفصاح في صفحة التحقق وواجهة
    // /api/certificates/verify. من يقدّم الرمز نفسه يرى الاعتماد الكامل.
    const accessMode = resolveCertificateAccessMode(cert, clean)
    const displayedSerial = displayedCertificateSerial(cert)
    const credential = buildCertificateCredential({ ...cert, serial: displayedSerial, valid: effectiveValid }, { accessMode })
    return new NextResponse(
      JSON.stringify({
        valid: effectiveValid,
        statusLabel: effectiveValid ? 'سارية' : `ملغاة${revokedAt ? ` بتاريخ ${revokedAt.slice(0, 10)}` : ''}`,
        revokedAt,
        revokedReason: cert.revokedReason || null,
        proofVerified: verifyCertificateCredential(credential),
        verificationUrl: accessMode === 'TOKEN' ? certificateVerificationUrl(cert) : certificateSerialVerificationUrl(displayedSerial),
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
