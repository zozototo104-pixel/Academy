import { NextResponse } from 'next/server'

const W3C_CERTIFICATE_PROBE_PATH = '/api/verify/certificates/__route_probe__'
const HEALTH_PATH = '/api/health'

function jsonResponse(body: unknown, contentType = 'application/json; charset=utf-8') {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}

export function middleware(req: Request) {
  const url = new URL(req.url)

  if (url.pathname === HEALTH_PATH) {
    return jsonResponse({
      ok: true,
      status: 'ok',
      kind: 'liveness',
      source: 'middleware',
      message: 'Application middleware is deployed and responding. Use /api/ready for database readiness.',
      timestamp: new Date().toISOString(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA || 'unknown',
      readiness: '/api/ready',
    })
  }

  if (url.pathname === W3C_CERTIFICATE_PROBE_PATH) {
    return jsonResponse(
      {
        ok: true,
        route: 'w3c-certificate-verification',
        probe: true,
        '@context': ['https://www.w3.org/2018/credentials/v1'],
      },
      'application/ld+json; charset=utf-8'
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/health', '/api/verify/certificates/__route_probe__'],
}
