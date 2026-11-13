import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-11-13 (Haris, option B): an assigned supervisor may create the FIRST
// lecture series in his programs — assignment (admission supervisorId) is
// a valid scope for series creation, not only series ownership. The shared
// canManageProgram helper is NOT widened: video creation still requires
// series ownership, and the sessions/videos list scopes are unchanged.

const SUPERVISOR = { id: 'sup-1', name: 'المشرف', role: 'SUPERVISOR' }
const ADMIN = { id: 'admin-1', name: 'الأدمن', role: 'ADMIN' }

let currentActor: any = SUPERVISOR
let apps: any[] = []
let series: any[] = []
let users: any[] = []
let programs: any[] = []
let enrollments: any[] = []
let audits: any[] = []
let notified: any[] = []
let emailed: string[] = []
let createdSeries: any[] = []
let createdSessions: any[] = []
let origEnv: string | undefined

const fakeTx = {
  lectureSeries: {
    create: async ({ data }: any) => {
      const row = { id: 'SER-NEW', ...data }
      createdSeries.push(row)
      return row
    },
  },
  lectureSession: {
    createMany: async ({ data }: any) => {
      createdSessions.push(...data)
      return { count: data.length }
    },
  },
}

mock.module('@/lib/db', () => ({
  db: {
    program: {
      findUnique: async ({ where }: any) => programs.find((p) => p.id === where.id) || null,
    },
    user: {
      findUnique: async ({ where }: any) => users.find((u) => u.id === where.id) || null,
      findMany: async ({ where }: any = {}) =>
        users
          .filter((u) => !where?.id?.in || where.id.in.includes(u.id))
          .map((u) => ({ id: u.id, email: u.email })),
    },
    admissionApplication: {
      findMany: async ({ where }: any = {}) =>
        apps.filter((a) => {
          if (where?.supervisorId && a.supervisorId !== where.supervisorId) return false
          if (where?.programId) {
            if (typeof where.programId === 'string') {
              if (a.programId !== where.programId) return false
            } else if (where.programId?.not === null && a.programId == null) {
              return false
            }
          }
          if (where?.userId?.not === null && a.userId == null) return false
          return true
        }),
    },
    lectureSeries: {
      findFirst: async ({ where }: any = {}) =>
        series.find(
          (s) =>
            (!where?.programId || s.programId === where.programId) &&
            (!where?.supervisorId || s.supervisorId === where.supervisorId),
        ) || null,
      findMany: async ({ where }: any = {}) =>
        series.filter(
          (s) =>
            (!where?.supervisorId || s.supervisorId === where.supervisorId) &&
            (!where?.programId || s.programId === where.programId),
        ),
    },
    enrollment: { findMany: async () => enrollments },
    $transaction: async (fn: any) => fn(fakeTx),
  },
}))

mock.module('@/lib/auth', () => ({
  requireUser: async () => currentActor,
}))

mock.module('@/lib/notify', () => ({
  audit: async (...args: any[]) => {
    audits.push(args)
  },
  notify: async (userId: any, type: any, title: any, body: any, link?: any) => {
    notified.push({ userId, type, title, body, link })
    return true
  },
  notifyAdmins: async () => true,
}))

mock.module('@/lib/mailer', () => ({
  sendEmail: async ({ to }: any) => {
    emailed.push(to)
    return true
  },
}))

const seriesRoute = await import('@/app/api/admin/lectures/series/route')
const videosRoute = await import('@/app/api/admin/lectures/videos/route')
const { NextRequest } = await import('next/server')

const seriesPayload = (programId: string, extra: Record<string, unknown> = {}) =>
  new NextRequest('http://localhost/api/admin/lectures/series', {
    method: 'POST',
    body: JSON.stringify({
      programId,
      title: 'لقاء تجريبي',
      timezone: 'Asia/Gaza',
      durationMin: 60,
      deliveryMode: 'EXTERNAL_LINK',
      provider: 'ZOOM',
      meetingUrl: 'https://zoom.us/j/123456789',
      recurring: false,
      startDate: '2026-11-20',
      timeOfDay: '18:00',
      ...extra,
    }),
  })

beforeEach(() => {
  programs = [
    { id: 'prog-assigned', titleAr: 'برنامج معيّن' },
    { id: 'prog-owned', titleAr: 'برنامج مملوك' },
    { id: 'prog-none', titleAr: 'برنامج بلا صلة' },
  ]
  users = [
    { id: 'sup-1', role: 'SUPERVISOR' },
    { id: 'sup-2', role: 'SUPERVISOR' },
    { id: 'admin-1', role: 'ADMIN' },
  ]
  // sup-1 is assigned (admission) to prog-assigned and owns a series in
  // prog-owned; he has no series, session or video in prog-assigned.
  apps = [{ id: 'app-1', supervisorId: 'sup-1', programId: 'prog-assigned', userId: 'stu-1' }]
  series = [{ id: 'ser-owned', programId: 'prog-owned', supervisorId: 'sup-1', program: { titleAr: 'برنامج مملوك' } }]
  enrollments = []
  audits = []
  notified = []
  emailed = []
  createdSeries = []
  createdSessions = []
  currentActor = SUPERVISOR
  origEnv = process.env.LECTURES_ENABLED
  process.env.LECTURES_ENABLED = 'true'
})

afterEach(() => {
  if (origEnv === undefined) delete process.env.LECTURES_ENABLED
  else process.env.LECTURES_ENABLED = origEnv
})

describe('series POST — assigned supervisor may create the first series', () => {
  test('(a) assigned supervisor with NO series in the program creates → 201', async () => {
    const res = await seriesRoute.POST(seriesPayload('prog-assigned'))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.series.programId).toBe('prog-assigned')
    expect(body.series.supervisorId).toBe('sup-1')
    expect(body.sessionsCreated).toBe(1)
    expect(createdSeries.length).toBe(1)
    expect(createdSessions.length).toBe(1)
    expect(audits.length).toBe(1)
  })

  test('(b) supervisor assigned to ANOTHER program, trying an unassigned one, is still refused 403 with the exact new message — and nothing is created', async () => {
    const res = await seriesRoute.POST(seriesPayload('prog-none'))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('لا تملك صلاحية إنشاء سلسلة في هذا البرنامج — البرنامج ليس ضمن برامجك المعيّنة ولا تملك فيه سلسلة')
    expect(createdSeries.length).toBe(0)
    expect(createdSessions.length).toBe(0)
    expect(audits.length).toBe(0)
    expect(notified.length).toBe(0)
  })

  test('(c) admin still creates in any program → 201', async () => {
    currentActor = ADMIN
    const res = await seriesRoute.POST(seriesPayload('prog-none'))
    expect(res.status).toBe(201)
    expect(createdSeries.length).toBe(1)
  })

  test('(d) supervisor passing another supervisorId is still refused 403', async () => {
    const res = await seriesRoute.POST(seriesPayload('prog-assigned', { supervisorId: 'sup-2' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('لنفسه فقط')
    expect(createdSeries.length).toBe(0)
  })
})

describe('series GET — assigned programs are exposed for the create dialog', () => {
  test('(f) supervisor GET returns assignedProgramIds incl. a program with no series — and never an unassigned program', async () => {
    const res = await seriesRoute.GET(new NextRequest('http://localhost/api/admin/lectures/series'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.assignedProgramIds).toContain('prog-assigned')
    expect(body.assignedProgramIds).toContain('prog-owned')
    expect(body.assignedProgramIds).not.toContain('prog-none')
    expect(body.series.map((s: any) => s.id)).toEqual(['ser-owned'])
  })
})

describe('video POST — assignment alone still does NOT grant video management', () => {
  test('(e) assigned-but-owning-nothing supervisor is refused 403 on video create', async () => {
    const res = await videosRoute.POST(
      new NextRequest('http://localhost/api/admin/lectures/videos', {
        method: 'POST',
        body: JSON.stringify({
          programId: 'prog-assigned',
          title: 'فيديو تجريبي',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        }),
      }),
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('لا تملك صلاحية إدارة فيديوهات هذا البرنامج')
  })
})

describe('creation notification scope — supervisor notifies only HIS students', () => {
  const notifyFixture = () => {
    // ACTIVE enrollments in prog-assigned: stu-1 (sup-1's student),
    // stu-2 (sup-2's student), stu-3 (no supervisor at all). The mock
    // stands in for the ACTIVE-enrollment query — the code under test
    // does the intersection with the assignment table itself.
    enrollments = [{ userId: 'stu-1' }, { userId: 'stu-2' }, { userId: 'stu-3' }]
    apps = [
      { id: 'app-1', supervisorId: 'sup-1', programId: 'prog-assigned', userId: 'stu-1' },
      { id: 'app-2', supervisorId: 'sup-2', programId: 'prog-assigned', userId: 'stu-2' },
    ]
    users = [
      { id: 'sup-1', role: 'SUPERVISOR' },
      { id: 'sup-2', role: 'SUPERVISOR' },
      { id: 'admin-1', role: 'ADMIN' },
      { id: 'stu-1', role: 'STUDENT', email: 'stu-1@example.com' },
      { id: 'stu-2', role: 'STUDENT', email: 'stu-2@example.com' },
      { id: 'stu-3', role: 'STUDENT', email: 'stu-3@example.com' },
    ]
  }

  test('supervisor-created series notifies ONLY his assigned students actively enrolled in the program (in-app + email)', async () => {
    notifyFixture()
    const res = await seriesRoute.POST(seriesPayload('prog-assigned'))
    expect(res.status).toBe(201)
    expect(notified.map((n) => n.userId)).toEqual(['stu-1'])
    expect(notified[0].type).toBe('LECTURE_CREATED')
    expect(emailed).toEqual(['stu-1@example.com'])
  })

  test('admin-created series still notifies ALL program students (in-app + email)', async () => {
    notifyFixture()
    currentActor = ADMIN
    const res = await seriesRoute.POST(seriesPayload('prog-assigned'))
    expect(res.status).toBe(201)
    expect(notified.map((n) => n.userId).sort()).toEqual(['stu-1', 'stu-2', 'stu-3'])
    expect(emailed.sort()).toEqual(['stu-1@example.com', 'stu-2@example.com', 'stu-3@example.com'])
  })

  test('a student enrolled in two programs is notified only when the supervisor is HIS supervisor in THAT program', async () => {
    // stu-2 is ACTIVE in prog-owned and has an application there supervised
    // by sup-2 — but sup-1 is his supervisor in prog-assigned only. When
    // sup-1 creates a series in prog-owned, stu-2 must NOT be notified:
    // the assignment cross-check is per-program, not per-student.
    // (The mock's enrollment list stands in for ACTIVE enrollments in the
    // target program, as in the fixture above.)
    enrollments = [{ userId: 'stu-1' }, { userId: 'stu-2' }]
    apps = [
      { id: 'app-1', supervisorId: 'sup-1', programId: 'prog-owned', userId: 'stu-1' },
      { id: 'app-2', supervisorId: 'sup-1', programId: 'prog-assigned', userId: 'stu-2' },
      { id: 'app-3', supervisorId: 'sup-2', programId: 'prog-owned', userId: 'stu-2' },
    ]
    users = [
      { id: 'sup-1', role: 'SUPERVISOR' },
      { id: 'sup-2', role: 'SUPERVISOR' },
      { id: 'admin-1', role: 'ADMIN' },
      { id: 'stu-1', role: 'STUDENT', email: 'stu-1@example.com' },
      { id: 'stu-2', role: 'STUDENT', email: 'stu-2@example.com' },
    ]
    const res = await seriesRoute.POST(seriesPayload('prog-owned'))
    expect(res.status).toBe(201)
    expect(notified.map((n) => n.userId)).toEqual(['stu-1'])
    expect(emailed).toEqual(['stu-1@example.com'])
  })
})

describe('source pins — the widening lives in the series route only', () => {
  const routeSrc = readFileSync(join(import.meta.dir, '../../src/app/api/admin/lectures/series/route.ts'), 'utf8')
  const manageSrc = readFileSync(join(import.meta.dir, '../../src/lib/lectures/manage.ts'), 'utf8')
  const videosSrc = readFileSync(join(import.meta.dir, '../../src/app/api/admin/lectures/videos/route.ts'), 'utf8')
  const uiSrc = readFileSync(join(import.meta.dir, '../../src/components/aact/AdminLectures.tsx'), 'utf8')

  test('series POST checks ownership OR assignment', () => {
    expect(routeSrc).toContain('canManageProgram(actor, input.programId)')
    expect(routeSrc).toContain('canAccessProgram(actor, input.programId)')
    expect(routeSrc).toContain("from '@/lib/supervisor-scope'")
    // Notification recipients are scoped per-program, not per-student:
    // a student supervised by this supervisor in ANOTHER program must
    // never be notified about this program's series.
    expect(routeSrc).toContain('supervisorStudentIds(actor, input.programId)')
  })

  test('canManageProgram itself is NOT widened', () => {
    expect(manageSrc).not.toContain('canAccessProgram')
    expect(manageSrc).not.toContain('admissionApplication')
  })

  test('video create still checks canManageProgram only', () => {
    expect(videosSrc).toContain('canManageProgram(actor, input.programId)')
    expect(videosSrc).not.toContain('canAccessProgram')
  })

  test('client load merges assigned programs into the supervisor program list', () => {
    expect(uiSrc).toContain('assignedProgramIds')
    expect(uiSrc).toContain('for (const id of scopedSeries.assignedProgramIds || []) allowedProgramIds.add(id)')
  })

  test('supervisor program list contains ONLY his scoped programs — no fifth source feeds it', () => {
    // The create dialog options come from the filtered `programs` state,
    // never from the raw catalog: a program survives only when its id is
    // in allowedProgramIds, and exactly four server-derived sources feed
    // that set — owned series, assigned programs, lectured sessions,
    // visible videos.
    expect(uiSrc).toContain('visiblePrograms = allPrograms.filter((program) => allowedProgramIds.has(program.id))')
    expect(uiSrc).toContain('setPrograms(visiblePrograms)')
    expect(uiSrc).not.toContain('setPrograms(allPrograms)')
    expect(uiSrc).toContain('for (const series of scopedSeries.series || []) allowedProgramIds.add(series.programId)')
    expect(uiSrc).toContain('for (const id of scopedSeries.assignedProgramIds || []) allowedProgramIds.add(id)')
    expect(uiSrc).toContain('for (const session of nextSessions) allowedProgramIds.add(session.series.programId)')
    expect(uiSrc).toContain('for (const video of nextVideos) allowedProgramIds.add(video.programId)')
    expect(uiSrc.match(/allowedProgramIds\.add\(/g)?.length).toBe(4)
    // Both create dialogs render their program options from the filtered
    // `programs` prop.
    expect((uiSrc.match(/programs=\{programs\}/g) || []).length).toBe(2)
  })

  test('supervisor subtitle no longer claims first-series creation is admin-only', () => {
    expect(uiSrc).not.toContain('إنشاء أول سلسلة في أي برنامج يبقى من صلاحيات الإدارة')
    expect(uiSrc).toContain('يمكنك إنشاء سلسلة جديدة في أي من هذه البرامج')
  })
})
