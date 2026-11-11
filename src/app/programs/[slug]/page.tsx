import type { Metadata } from 'next'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { absoluteUrl, seoForProgram } from '@/lib/seo'
import { ProgramsStandaloneClient } from '../ProgramsStandaloneClient'

type ProgramPageProps = { params: Promise<{ slug: string }> }

// Both the metadata and the page use the same active database record.
const getProgram = cache(async (slug: string) => db.program.findFirst({
  where: { active: true, OR: [{ slug }, { id: slug }] },
  select: {
    id: true,
    slug: true,
    titleAr: true,
    description: true,
    category: true,
    price: true,
    hours: true,
  },
}))

export async function generateMetadata({ params }: ProgramPageProps): Promise<Metadata> {
  const { slug } = await params
  const program = await getProgram(slug)
  if (!program) notFound()
  return seoForProgram(program)
}

export default async function ProgramDetailRoutePage({ params }: ProgramPageProps) {
  const { slug } = await params
  const program = await getProgram(slug)
  if (!program) notFound()

  const path = `/programs/${encodeURIComponent(program.slug || program.id)}`
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'EducationalOccupationalProgram',
    name: program.titleAr,
    description: program.description,
    url: absoluteUrl(path),
    provider: {
      '@type': 'EducationalOrganization',
      name: 'الأكاديمية الأمريكية للاستشارات والتدريب',
      url: absoluteUrl('/'),
    },
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }}
      />
      <ProgramsStandaloneClient />
    </>
  )
}
