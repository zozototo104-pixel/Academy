import { NextResponse } from 'next/server'

export const dynamic = 'force-static'

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || 'https://aactacademy.com').replace(/\/$/, '')
}

export function GET() {
  const base = appUrl()
  return NextResponse.json(
    {
      id: `${base}/issuer/aact`,
      type: ['Organization', 'VerifiableCredentialIssuer'],
      name: 'American Academy for Consulting and Training',
      alternateName: 'AACT',
      url: base,
      verificationMethod: [
        {
          id: `${base}/issuer/aact#internal-hmac-sha256`,
          type: 'HmacSha256VerificationKey2026',
          controller: `${base}/issuer/aact`,
          note: 'Internal server-side signature key. The secret is not public; public verification is performed by the AACT verification endpoint.',
        },
      ],
      assertionMethod: [`${base}/issuer/aact#internal-hmac-sha256`],
    },
    { headers: { 'Content-Type': 'application/ld+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
  )
}
