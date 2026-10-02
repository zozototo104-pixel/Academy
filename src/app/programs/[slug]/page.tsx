import type { Metadata } from 'next'
import { ProgramsStandaloneClient } from '../ProgramsStandaloneClient'

export const metadata: Metadata = {
  title: 'تفاصيل البرنامج | AACT',
  description: 'تفاصيل برامج وخدمات الأكاديمية الأمريكية للاستشارات والتدريب ضمن نفس تجربة الموقع الرسمية.',
}

export default function ProgramDetailRoutePage() {
  return <ProgramsStandaloneClient />
}
