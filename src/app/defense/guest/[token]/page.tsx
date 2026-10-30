import { DefenseGuestEntry } from '@/components/aact/DefenseGuestEntry'

// صفحة دخول المناقش الخارجي لقاعة المناقشة برابط دعوة شخصي (بدون حساب)
export default async function DefenseGuestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <DefenseGuestEntry token={token} />
}
