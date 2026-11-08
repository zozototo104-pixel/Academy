import type { Metadata } from 'next'
import { ApplyStandaloneClient } from './ApplyStandaloneClient'

export const metadata: Metadata = {
  title: 'طلب الالتحاق',
  description: 'قدّم طلب الالتحاق أو طلب خدمة مهنية في الأكاديمية الأمريكية للاستشارات والتدريب عبر النموذج الرسمي.',
  alternates: { canonical: '/apply' },
}

export default function ApplyPage() {
  return <ApplyStandaloneClient />
}
