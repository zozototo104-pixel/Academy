import type { MetadataRoute } from 'next'
import { db } from '@/lib/db'
import { PUBLIC_SEO_ROUTES, absoluteUrl } from '@/lib/seo'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const publicRoutes: MetadataRoute.Sitemap = PUBLIC_SEO_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: now,
    changeFrequency: (route.path === '/' || route.path === '/programs' ? 'weekly' : 'monthly') as const,
    priority: route.priority,
  }))

  const programs = await db.program.findMany({
    where: { active: true },
    select: { slug: true, id: true, order: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: 500,
  }).catch(() => [])

  const programRoutes: MetadataRoute.Sitemap = programs.map((program) => ({
    url: absoluteUrl(`/programs/${program.slug || program.id}`),
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.82,
  }))

  return [...publicRoutes, ...programRoutes]
}
