import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeAuditDetails } from '../../src/lib/lectures/audit'

// Guards for the management side: role gate on every route, supervisor
// scope checks, notifications on lifecycle events, and a hard rule that
// no lecture code path writes to the console (where secrets could leak).

const apiRoot = join(import.meta.dir, '../../src/app/api/admin/lectures')
const libRoot = join(import.meta.dir, '../../src/lib/lectures')

const routeFiles = [
  'series/route.ts',
  'series/[id]/route.ts',
  'sessions/route.ts',
  'sessions/[id]/route.ts',
  'sessions/[id]/postpone/route.ts',
  'sessions/[id]/cancel/route.ts',
  'sessions/[id]/attendance/route.ts',
  'videos/route.ts',
  'videos/[id]/route.ts',
]

function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), 'utf8')
}

describe('audit details sanitizer', () => {
  test('strips secret-bearing keys and keeps the rest', () => {
    const out = safeAuditDetails({
      programId: 'p1',
      meetingUrl: 'https://zoom.us/j/secret',
      meetingPasscode: '123456',
      apiToken: 'x',
      sessions: 4,
    })
    expect(out).toContain('programId')
    expect(out).toContain('"sessions":4')
    expect(out).not.toContain('zoom.us')
    expect(out).not.toContain('123456')
    expect(out).not.toContain('apiToken')
  })
})

describe('admin lecture route guards', () => {
  test('every management route requires a lecture manager', () => {
    for (const rel of routeFiles) {
      expect(read(apiRoot, rel)).toContain('requireLectureManager()')
    }
  })

  test('series and session mutations check supervisor scope', () => {
    for (const rel of ['series/[id]/route.ts', 'sessions/route.ts']) {
      expect(read(apiRoot, rel)).toContain('canManageSeries')
    }
    // منذ نموذج «المحاضر لكل لقاء» (2026-10-29): تعديلات اللقاء بعينه تُفحص
    // بالمحاضر الفعلي (canManageSession) الذي يرجع لمشرف السلسلة عند غياب
    // محاضر خاص — فحص أضيق من ملكية السلسلة، لا أوسع.
    for (const rel of ['sessions/[id]/route.ts', 'sessions/[id]/postpone/route.ts', 'sessions/[id]/cancel/route.ts', 'sessions/[id]/attendance/route.ts']) {
      expect(read(apiRoot, rel)).toContain('canManageSession')
    }
    for (const rel of ['videos/route.ts', 'videos/[id]/route.ts']) {
      expect(read(apiRoot, rel)).toContain('canManageProgram')
    }
  })

  test('lifecycle events notify program students', () => {
    for (const rel of ['series/route.ts', 'sessions/route.ts', 'sessions/[id]/postpone/route.ts', 'sessions/[id]/cancel/route.ts']) {
      expect(read(apiRoot, rel)).toContain('notifyProgramStudents')
    }
  })

  test('series creation generates occurrences with the recurrence engine', () => {
    expect(read(apiRoot, 'series/route.ts')).toContain('generateWeeklyOccurrences')
  })

  test('postpone keeps the original as RESCHEDULED and creates a replacement', () => {
    const postpone = read(apiRoot, 'sessions/[id]/postpone/route.ts')
    expect(postpone).toContain("status: 'RESCHEDULED'")
    expect(postpone).toContain("status: 'SCHEDULED'")
    expect(postpone).toContain('lectureSession.create')
    expect(postpone).toContain('lectureSession.update')
  })

  test('attendance confirmation records the confirmer and enrollment scope', () => {
    const attendance = read(apiRoot, 'sessions/[id]/attendance/route.ts')
    expect(attendance).toContain('confirmedById')
    expect(attendance).toContain('getProgramStudentIds')
    expect(attendance).toContain("'PRESENT'")
    expect(attendance).toContain("'ABSENT'")
  })

  test('no lecture route or library file writes to the console', () => {
    for (const rel of routeFiles) {
      expect(read(apiRoot, rel)).not.toContain('console.')
    }
    for (const rel of ['student.ts', 'access.ts', 'manage.ts', 'recurrence.ts', 'ics.ts', 'audit.ts', 'config.ts']) {
      expect(read(libRoot, rel)).not.toContain('console.')
    }
  })

  test('plain session edits cannot move times (postpone is the only path)', () => {
    const patch = read(apiRoot, 'sessions/[id]/route.ts')
    expect(patch).toContain("'startsAt' in raw")
  })
})
