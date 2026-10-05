import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { ProgramsStandaloneClient } from '../ProgramsStandaloneClient'

export const metadata: Metadata = {
  title: 'تفاصيل البرنامج | AACT',
  description: 'تفاصيل برامج وخدمات الأكاديمية الأمريكية للاستشارات والتدريب ضمن نفس تجربة الموقع الرسمية.',
}

export default async function ProgramDetailRoutePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const program = await db.program.findFirst({
    where: {
      active: true,
      OR: [
        { slug },
        { id: slug },
      ],
    },
    select: { id: true },
  })

  if (!program) notFound()

  return <ProgramsStandaloneClient />
}
