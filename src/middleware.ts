import { NextResponse } from 'next/server'

const W3C_CERTIFICATE_PROBE_PATH = '/api/verify/certificates/__route_probe__'

export function middleware(req: Request) {
  const url = new URL(req.url)

  if (url.pathname === W3C_CERTIFICATE_PROBE_PATH) {
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

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/verify/certificates/__route_probe__'],
}
