import type { Metadata } from 'next'
import { seoForPath } from '@/lib/seo'
export { default } from '../page'

type PageProps = { params: Promise<{ path?: string[] }> | { path?: string[] } }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await Promise.resolve(params)
  const pathname = `/${(resolved.path || []).join('/')}`
  return seoForPath(pathname)
}
