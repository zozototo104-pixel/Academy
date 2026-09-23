import { NextResponse } from 'next/server'

export const dynamic = 'force-static'

export function GET() {
  return NextResponse.json(
    {
      '@context': {
        '@version': 1.1,
        AACTCertificateCredential: 'https://aactacademy.com/terms/AACTCertificateCredential',
        AACTCertificateHolder: 'https://aactacademy.com/terms/AACTCertificateHolder',
        certificateSerial: 'https://aactacademy.com/terms/certificateSerial',
        certificateType: 'https://aactacademy.com/terms/certificateType',
        program: 'https://aactacademy.com/terms/program',
        grade: 'https://aactacademy.com/terms/grade',
        country: 'https://aactacademy.com/terms/country',
        AACTCertificateStatus2026: 'https://aactacademy.com/terms/AACTCertificateStatus2026',
        AACTCertificateEvidence: 'https://aactacademy.com/terms/AACTCertificateEvidence',
      },
    },
    { headers: { 'Content-Type': 'application/ld+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
  )
}
