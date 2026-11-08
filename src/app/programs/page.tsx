import { seoForPath } from '@/lib/seo'
import { ProgramsStandaloneClient } from './ProgramsStandaloneClient'

export const metadata = seoForPath('/programs')

export default function ProgramsPage() {
  return <ProgramsStandaloneClient />
}
