import type { MetadataRoute } from 'next'
import { PUBLIC_SEO_ROUTES, absoluteUrl } from '@/lib/seo'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const publicRoutes: MetadataRoute.Sitemap = PUBLIC_SEO_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: now,
    changeFrequency: route.path === '/' || route.path === '/programs' ? ('weekly' as const) : ('monthly' as const),
    priority: route.priority,
  }))

  let programs: Array<{ slug: string | null; id: string }> = []
  try {
    const { db } = await import('@/lib/db')
    programs = await db.program.findMany({
      where: { active: true },
      select: { slug: true, id: true },
      orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
      take: 500,
    })
  } catch (error) {
    console.warn('Sitemap program route lookup failed; returning static public routes only.', error)
  }

  const programRoutes: MetadataRoute.Sitemap = programs.map((program) => ({
    url: absoluteUrl(`/programs/${program.slug || program.id}`),
    lastModified: now,
    changeFrequency: 'monthly' as const,
    priority: 0.82,
  }))

  let representatives: Array<{ slug: string }> = []
  try {
    const { db } = await import('@/lib/db')
    representatives = await db.academyRepresentative.findMany({
      where: { status: 'ACTIVE' },
      select: { slug: true },
      orderBy: [{ fullName: 'asc' }],
      take: 500,
    })
  } catch (error) {
    console.warn('Sitemap representative route lookup failed; returning routes without representatives.', error)
  }

  const representativeRoutes: MetadataRoute.Sitemap = representatives.map((representative) => ({
    url: absoluteUrl(`/representatives/${representative.slug}`),
    lastModified: now,
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }))

  return [...publicRoutes, ...programRoutes, ...representativeRoutes]
}
