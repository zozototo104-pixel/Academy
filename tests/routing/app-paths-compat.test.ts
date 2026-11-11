import { describe, expect, test } from 'bun:test'
import { isKnownAppPath } from '../../src/lib/app-paths'
import { routeStateFromLocation } from '../../src/lib/app-routes'

// Compatibility contract for the [...path] catch-all soft-404 fix:
// every URL shape the client shell can actually resolve to a view MUST stay
// reachable (no 404), and every shape it cannot resolve MUST be refused so
// the catch-all answers with a real 404 instead of the app shell.

const KNOWN: Array<[string, string[]]> = [
  ['/about', ['about']],
  ['/admin', ['admin']],
  ['/auth', ['auth']],
  ['/certificates', ['certificates']],
  ['/chat', ['chat']],
  ['/dashboard', ['dashboard']],
  ['/directory', ['directory']],
  ['/login', ['login']],
  ['/supervisor', ['supervisor']],
  ['/visitor', ['visitor']],
  ['/unit/unit-123', ['unit', 'unit-123']],
  ['/exam/exam-9', ['exam', 'exam-9']],
  ['/verify/certificates', ['verify', 'certificates']],
  ['/dashboard/program/prog-1', ['dashboard', 'program', 'prog-1']],
  ['/admin/students/stu-1', ['admin', 'students', 'stu-1']],
  ['/admin/agents/agt-1', ['admin', 'agents', 'agt-1']],
]

const UNKNOWN: Array<[string, string[]]> = [
  ['/register', ['register']],
  ['/services', ['services']],
  ['/home', ['home']],
  ['/nonexistent-page', ['nonexistent-page']],
  ['/programs', ['programs']],
  ['/programs/some-slug', ['programs', 'some-slug']],
  ['/unit', ['unit']],
  ['/exam', ['exam']],
  ['/verify', ['verify']],
  ['/verify/other', ['verify', 'other']],
  ['/verify/certificates/token-1', ['verify', 'certificates', 'token-1']],
  ['/dashboard/other/x', ['dashboard', 'other', 'x']],
  ['/admin/other/x', ['admin', 'other', 'x']],
  ['/admin/students', ['admin', 'students']],
  ['/unit/a/b', ['unit', 'a', 'b']],
  ['/a/b/c/d', ['a', 'b', 'c', 'd']],
]

describe('catch-all allowlist (soft-404 fix)', () => {
  for (const [label, parts] of KNOWN) {
    test(`known path stays reachable: ${label}`, () => {
      expect(isKnownAppPath(parts)).toBe(true)
    })
  }
  for (const [label, parts] of UNKNOWN) {
    test(`unknown path is refused: ${label}`, () => {
      expect(isKnownAppPath(parts)).toBe(false)
    })
  }

  test('allowlist agrees with the client router on every path-resolved single view', () => {
    const singles = ['about', 'admin', 'auth', 'certificates', 'chat', 'dashboard', 'directory', 'login', 'supervisor']
    for (const segment of singles) {
      const state = routeStateFromLocation(`/${segment}`, '')
      expect(state.view, segment).not.toBe('home')
      expect(isKnownAppPath([segment])).toBe(true)
    }
  })

  test('visitor view is reached by post-login navigation, not by path parsing', () => {
    // routeStateFromLocation has no 'visitor' path case, but the shell DOES
    // render a visitor view when navigation selects it after login
    // (src/app/page.tsx renders <VisitorMeetings /> for view 'visitor').
    // '/visitor' is a real legacy shell path and must stay reachable.
    expect(isKnownAppPath(['visitor'])).toBe(true)
  })

  test('client router falls back to home exactly where the allowlist refuses', () => {
    // 'register' and 'services' are not views: the client resolves them to
    // the home fallback, which is precisely why the server must 404 them.
    expect(routeStateFromLocation('/register', '').view).toBe('home')
    expect(isKnownAppPath(['register'])).toBe(false)
    expect(routeStateFromLocation('/services', '').view).toBe('home')
    expect(isKnownAppPath(['services'])).toBe(false)
  })

  test('parameterized shapes agree with the client router', () => {
    expect(routeStateFromLocation('/unit/u1', '').view).toBe('unit')
    expect(isKnownAppPath(['unit', 'u1'])).toBe(true)
    expect(routeStateFromLocation('/exam/e1', '').view).toBe('exam')
    expect(isKnownAppPath(['exam', 'e1'])).toBe(true)
    expect(routeStateFromLocation('/dashboard/program/p1', '').view).toBe('dashboard')
    expect(isKnownAppPath(['dashboard', 'program', 'p1'])).toBe(true)
    expect(routeStateFromLocation('/admin/students/s1', '').view).toBe('student-preview')
    expect(isKnownAppPath(['admin', 'students', 's1'])).toBe(true)
    expect(routeStateFromLocation('/admin/agents/a1', '').view).toBe('agent-preview')
    expect(isKnownAppPath(['admin', 'agents', 'a1'])).toBe(true)
    // The legacy verify alias resolves to the verify view in the client.
    expect(routeStateFromLocation('/verify/certificates', '').view).toBe('verify')
    expect(isKnownAppPath(['verify', 'certificates'])).toBe(true)
  })
})
