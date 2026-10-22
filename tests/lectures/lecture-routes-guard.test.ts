import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Source-level guards for the student lecture endpoints: these invariants
// (auth on every route, no meeting credentials outside the join window,
// signed URLs only after access checks) must survive future edits.

const apiRoot = join(import.meta.dir, '../../src/app/api/my')

function readRoute(rel: string): string {
  return readFileSync(join(apiRoot, rel), 'utf8')
}

const sessionRoutes = [
  'lectures/route.ts',
  'lectures/next/route.ts',
  'lectures/[sessionId]/route.ts',
  'lectures/[sessionId]/join/route.ts',
  'lectures/[sessionId]/ics/route.ts',
]
const videoRoutes = [
  'lecture-videos/route.ts',
  'lecture-videos/[videoId]/watch/route.ts',
  'lecture-videos/[videoId]/progress/route.ts',
]

describe('student lecture route guards', () => {
  test('every route requires an authenticated user', () => {
    for (const rel of [...sessionRoutes, ...videoRoutes]) {
      expect(readRoute(rel)).toContain('requireUser()')
    }
  })

  test('meeting credentials are referenced by the join route only', () => {
    for (const rel of [...sessionRoutes, ...videoRoutes]) {
      if (rel.includes('join')) continue
      expect(readRoute(rel)).not.toContain('meetingUrl')
      expect(readRoute(rel)).not.toContain('meetingPasscode')
    }
  })

  test('list, next and detail responses pass through the public projection', () => {
    for (const rel of ['lectures/route.ts', 'lectures/next/route.ts', 'lectures/[sessionId]/route.ts']) {
      expect(readRoute(rel)).toContain('toPublicSession')
    }
  })

  test('join is window-gated with 403 and rate-limited, and records JOINED only', () => {
    const join = readRoute('lectures/[sessionId]/join/route.ts')
    expect(join).toContain('isJoinWindowOpen')
    expect(join).toContain('status: 403')
    expect(join).toContain('checkDatabaseRateLimit')
    expect(join).toContain("status: 'JOINED'")
    expect(join).not.toContain("status: 'PRESENT'")
    expect(join).not.toContain('confirmedAt')
  })

  test('program access is checked server-side on detail, ics, join and video routes', () => {
    for (const rel of [
      'lectures/[sessionId]/route.ts',
      'lectures/[sessionId]/ics/route.ts',
      'lectures/[sessionId]/join/route.ts',
      'lecture-videos/[videoId]/watch/route.ts',
      'lecture-videos/[videoId]/progress/route.ts',
    ]) {
      expect(readRoute(rel)).toContain('canStudentAccessProgram')
    }
    for (const rel of ['lectures/route.ts', 'lectures/next/route.ts', 'lecture-videos/route.ts']) {
      expect(readRoute(rel)).toContain('getActiveLectureProgramIds')
    }
  })

  test('signed storage URLs are issued only after publish + access checks', () => {
    const watch = readRoute('lecture-videos/[videoId]/watch/route.ts')
    const publishedCheck = watch.indexOf("video.status !== 'PUBLISHED'")
    const accessCheck = watch.indexOf('await canStudentAccessProgram')
    // L6: التوقيع صار بدالة المحاضرات المستقلة (ساعة) بقرار مالك المشروع،
    // ونفس ترتيب الحراسة يبقى: النشر ثم الصلاحية ثم التوقيع.
    const signing = watch.indexOf('createLectureVideoSignedUrl(video.storageKey)')
    expect(publishedCheck).toBeGreaterThan(-1)
    expect(accessCheck).toBeGreaterThan(publishedCheck)
    expect(signing).toBeGreaterThan(accessCheck)
    expect(watch).not.toContain('storageKey:')
  })

  test('video list exposes published videos only and no storage keys or file urls', () => {
    const list = readRoute('lecture-videos/route.ts')
    expect(list).toContain("status: 'PUBLISHED'")
    expect(list).not.toContain('storageKey')
    expect(list).not.toContain('originalUrl')
  })
})
