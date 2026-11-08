import { NextResponse } from 'next/server'

const W3C_CERTIFICATE_PROBE_PATH = '/api/verify/certificates/__route_probe__'

// An actual plain-text resource, rather than the SPA fallback HTML.
const LLMS_TEXT = `# American Academy for Consulting and Training (AACT)

> Official public pages. Program details are maintained by the academy and may change.

## Official pages
- [Home](https://www.aactacademy.com/)
- [Programs and professional services](https://www.aactacademy.com/programs)
- [Applications](https://www.aactacademy.com/apply)
- [Accreditation and official documents](https://www.aactacademy.com/accreditation)
- [Certificate verification](https://www.aactacademy.com/verify)
- [Representatives](https://www.aactacademy.com/representatives)
- [Contact](https://www.aactacademy.com/contact)
- [Privacy](https://www.aactacademy.com/privacy)
- [Terms](https://www.aactacademy.com/terms)

## Program details
Active program pages use /programs/{slug}; consult each page for its official title and description.
`

export function proxy(req: Request) {
  const url = new URL(req.url)

  if (url.pathname === '/llms.txt') {
    return new NextResponse(LLMS_TEXT, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  }

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
  matcher: ['/api/:path*', '/llms.txt'],
}
