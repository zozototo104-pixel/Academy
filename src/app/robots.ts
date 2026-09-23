import type { MetadataRoute } from 'next'
import { PRIVATE_ROUTE_PREFIXES, siteUrl } from '@/lib/seo'

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl()
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          ...PRIVATE_ROUTE_PREFIXES.map((p) => `${p}/`),
          '/api/',
          '/_next/',
          '/pdf/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  }
}
