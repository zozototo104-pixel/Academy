type PublicProgramsSummaryPayload = { programs: any[]; catalogVersion?: string | null }

const PUBLIC_PROGRAMS_CACHE_TTL_MS = 5 * 60 * 1000

let publicProgramsSummaryCache: { expiresAt: number; payload: PublicProgramsSummaryPayload } | null = null
let publicProgramsCountCache: { expiresAt: number; count: number; catalogVersion?: string | null } | null = null

export function publicProgramsCacheTtlMs() {
  return PUBLIC_PROGRAMS_CACHE_TTL_MS
}

export function getPublicProgramsSummaryCache() {
  return publicProgramsSummaryCache
}

export function setPublicProgramsSummaryCache(payload: PublicProgramsSummaryPayload) {
  publicProgramsSummaryCache = { payload, expiresAt: Date.now() + PUBLIC_PROGRAMS_CACHE_TTL_MS }
}

export function getPublicProgramsCountCache() {
  return publicProgramsCountCache
}

export function setPublicProgramsCountCache(count: number, catalogVersion?: string | null) {
  publicProgramsCountCache = { count, catalogVersion, expiresAt: Date.now() + PUBLIC_PROGRAMS_CACHE_TTL_MS }
}

export function clearPublicProgramsCache() {
  publicProgramsSummaryCache = null
  publicProgramsCountCache = null
}
