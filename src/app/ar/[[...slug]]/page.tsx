import { redirect } from 'next/navigation'

export default async function LegacyArabicRoute({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params
  const target = slug.length ? `/${slug.map(encodeURIComponent).join('/')}` : '/'
  redirect(target)
}
