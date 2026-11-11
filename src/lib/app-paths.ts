// The single source of truth for which URL paths the client-side academy
// shell (served by the [...path] catch-all) actually understands. Derived
// from routeStateFromLocation in src/lib/app-routes.ts — every path shape
// the client router can resolve to a view is listed here; anything else is
// not a page of this platform and must answer with a real 404 instead of
// the app shell (soft-404). Dedicated Next routes (programs/[slug], verify,
// meetings/[token], pdf/*, ...) take precedence over the catch-all and are
// NOT governed by this list.

const SINGLE_SEGMENT_VIEWS = new Set([
  'about',
  'admin',
  'auth',
  'certificates',
  'chat',
  'dashboard',
  'directory',
  'login',
  'supervisor',
  'visitor',
])

export function isKnownAppPath(parts: string[]): boolean {
  // '/' itself is served by src/app/page.tsx, never by the catch-all.
  if (parts.length === 0) return true
  if (parts.length === 1) return SINGLE_SEGMENT_VIEWS.has(parts[0])
  if (parts.length === 2) {
    const [first, second] = parts
    if (!second) return false
    return first === 'unit' || first === 'exam' || (first === 'verify' && second === 'certificates')
  }
  if (parts.length === 3) {
    const [first, second, third] = parts
    if (!third) return false
    return (first === 'dashboard' && second === 'program')
      || (first === 'admin' && (second === 'students' || second === 'agents'))
  }
  return false
}
