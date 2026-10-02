import type { Metadata } from 'next'
import { ProgramsStandaloneClient } from './ProgramsStandaloneClient'

export const metadata: Metadata = {
  title: 'البرامج والخدمات المهنية | AACT',
  description: 'استكشف برامج الأكاديمية الأمريكية للاستشارات والتدريب: الماجستير المهني، الدكتوراه المهنية، الدبلومات، الشهادات الدولية، الاعتمادات والخدمات المهنية.',
}

export default function ProgramsPage() {
  return <ProgramsStandaloneClient />
}
