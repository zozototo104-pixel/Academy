import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
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
