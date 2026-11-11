import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { absoluteUrl, seoForPath } from '@/lib/seo'
export { default } from '../page'

type PageProps = { params: Promise<{ path?: string[] }> | { path?: string[] } }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await Promise.resolve(params)
  const parts = resolved.path || []
  const pathname = `/${parts.join('/')}`

  if (parts[0] === 'programs' && parts[1]) {
    const key = decodeURIComponent(parts[1])
    const program = await db.program.findFirst({
      where: { OR: [{ slug: key }, { id: key }], active: true },
      select: { slug: true, id: true, titleAr: true, titleEn: true, description: true, category: true, price: true, hours: true },
    }).catch(() => null)

    if (program) {
      const path = `/programs/${program.slug || program.id}`
      const title = program.titleAr
      const description = program.description?.slice(0, 240) || 'برنامج مهني لدى الأكاديمية الأمريكية للاستشارات والتدريب.'
      return {
        title,
        description,
        alternates: { canonical: path },
        robots: { index: true, follow: true },
        openGraph: {
          title,
          description,
          url: absoluteUrl(path),
          siteName: 'AACT',
          type: 'website',
          locale: 'ar',
        },
        twitter: {
          card: 'summary_large_image',
          title,
          description,
        },
        other: {
          'program:category': program.category,
          ...(program.hours ? { 'program:hours': String(program.hours) } : {}),
          ...(program.price ? { 'program:price': String(program.price) } : {}),
        },
      }
    }
  }

  return seoForPath(pathname)
}
