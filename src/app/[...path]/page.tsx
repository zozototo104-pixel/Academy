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
    return (parts[0] === 'unit' || parts[0] === 'exam') && !!parts[1]
      || (parts[0] === 'verify' && parts[1] === 'certificates')
  }
  if (parts.length === 3) {
    return parts[0] === 'dashboard' && parts[1] === 'program' && !!parts[2]
      || parts[0] === 'admin' && (parts[1] === 'students' || parts[1] === 'agents') && !!parts[2]
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
