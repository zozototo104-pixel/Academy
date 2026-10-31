import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards for the student lectures UI: the meeting link may only ever come
// from the join response at click time, the tab must be server-gated, and
// progress saving must target the lectures progress endpoint only.

const root = join(import.meta.dir, '../..')
const component = readFileSync(join(root, 'src/components/aact/StudentLectures.tsx'), 'utf8')
const dashboard = readFileSync(join(root, 'src/components/aact/DashboardView.tsx'), 'utf8')
const shell = readFileSync(join(root, 'src/components/aact/Shell.tsx'), 'utf8')
const listRoute = readFileSync(join(root, 'src/app/api/my/lectures/route.ts'), 'utf8')

describe('student lectures UI guards', () => {
  test('join is a click-time POST and the link opens from its response only', () => {
    expect(component).toContain('/join')
    expect(component).toContain("method: 'POST'")
    expect(component).toContain('window.open(res.meetingUrl')
    // The word meetingUrl appears exactly twice: the join response type and
    // its single use. Session objects from the list never carry the field.
    expect((component.match(/meetingUrl/g) ?? []).length).toBe(2)
    expect(component).not.toContain('session.meetingUrl')
  })

  test('component uses the server-provided join window and handles 404', () => {
    expect(component).toContain('joinOpensAt')
    expect(component).toContain('e?.status === 404')
    expect(component).toContain('/api/my/lecture-videos')
    expect(component).toContain('/progress')
    expect(component).not.toContain('storageKey')
  })

  test('selected recording opens in a modal with its own player instance and stable selection', () => {
    expect(component).toContain('<Dialog open={Boolean(activeWatch)}')
    expect(component).toContain('key={activeWatch.video.id}')
    expect(component).toContain('requestId !== watchRequestRef.current')
    expect(component).toContain('setActiveWatch({ video, watch })')
    expect(component).toContain('onEnded={() => void markWatched(activeWatch.video)}')
    expect(component).toContain('saveProgress(activeWatch.video.id, positionSec, watchedPercent)')
    expect(component).not.toContain('<div className="mb-4 space-y-2">\n              <LecturePlayer')
  })

  test('admin mobile notifications use the real notification bell without redirecting', () => {
    expect(shell).toContain("user?.role === 'ADMIN' ? (")
    expect(shell).toContain('<NotificationBell mobile />')
    expect(shell).toContain("onClick={openMobileNotifications}")
    expect(shell).toContain("if (mobile) setMobileMenuOpen(false)")
    expect(shell).toContain("api('/api/notifications', { method: 'PATCH'")
  })

  test('dashboard tab is gated by a server probe, not a client flag', () => {
    expect(dashboard).toContain('lecturesVisible')
    expect(dashboard).toContain("fetch('/api/my/lectures'")
    expect(dashboard).toContain('value="lectures"')
    expect(dashboard).toContain('<StudentLectures />')
    expect(dashboard).toContain("'lectures'")
  })

  test('lectures list returns 404 when the student has no enabled program', () => {
    expect(listRoute).toContain('غير متاحة لبرامجك')
    expect(listRoute).toContain('status: 404')
  })
})
