import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { seoForPath } from '@/lib/seo'
import Home from '../page'

type PageProps = { params: Promise<{ path?: string[] }> | { path?: string[] } }

// This catch-all exists for the original client-side academy routes only.
// Dedicated Next routes (meeting invitations, defense guests, certificate and
// representative verification, password reset, programs, etc.) have priority.
const LEGACY_SINGLE_PATHS = new Set([
  'about', 'admin', 'auth', 'certificates', 'chat', 'dashboard',
  'directory', 'login', 'supervisor', 'visitor',
])

function isKnownLegacyPath(parts: string[]) {
  if (parts.length === 1) return LEGACY_SINGLE_PATHS.has(parts[0])
  if (parts.length === 2) {
    const [first, second] = parts
    return ((first === 'unit' || first === 'exam') && Boolean(second))
      || (first === 'verify' && second === 'certificates')
  }
  if (parts.length === 3) {
    const [first, second, third] = parts
    return Boolean(third) && (
      (first === 'dashboard' && second === 'program')
      || (first === 'admin' && (second === 'students' || second === 'agents'))
    )
  }
  return false
}

async function resolvePath(params: PageProps['params']) {
  const { path = [] } = await Promise.resolve(params)
  if (!isKnownLegacyPath(path)) notFound()
  return path
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const parts = await resolvePath(params)
  // A former verify alias displays the same certificate verification screen.
  return seoForPath(parts.join('/') === 'verify/certificates' ? '/verify' : `/${parts.join('/')}`)
}

export default async function LegacyAcademyPage({ params }: PageProps) {
  await resolvePath(params)
  return <Home />
}
