import { redirect } from 'next/navigation'

export default function LegacyArabicRoute({ params }: { params?: { slug?: string[] } }) {
  const slug = params?.slug || []
  const target = slug.length ? `/${slug.map(encodeURIComponent).join('/')}` : '/'
  redirect(target)
}
