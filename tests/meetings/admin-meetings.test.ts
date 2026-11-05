// قاعة الاجتماعات — اختبارات المنطق والدخول بفاكس في الذاكرة.
// التشغيل: bun test tests/meetings/admin-meetings.test.ts (منفردًا —
// المُحاكاة تتسرب بين الملفات).
import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/rate-limit', () => ({
  checkDatabaseRateLimit: async () => ({ allowed: true, ok: true }),
}))

const {
  generateMeetingToken,
  hashMeetingToken,
  isMeetingJoinOpen,
  deriveMeetingStatus,
  meetingInviteProblem,
  validateMeetingVideo,
  meetingAccessFor,
} = await import('@/lib/admin-meetings')
const { meetingState, meetingAction } = await import('@/lib/meeting-entry')
const { generateMinutesDraft } = await import('@/lib/meeting-minutes')

const T0 = new Date('2026-11-10T12:00:00.000Z')
const at = (min: number) => new Date(T0.getTime() + min * 60_000)
const meeting = (over: any = {}) => ({
  id: 'm1',
  title: 'اجتماع الإدارة',
  description: 'وصف',
  agenda: 'جدول سري',
  startsAt: T0,
  endsAt: at(60),
  timezone: 'Asia/Gaza',
  provider: 'ZOOM',
  meetingUrl: 'https://us02web.zoom.us/j/123',
  meetingPasscode: '999',
  hostName: 'الإدارة',
  status: 'SCHEDULED',
  aiAssistantEnabled: false,
  minutesEnabled: true,
  ...over,
})
const invite = (over: any = {}) => ({
  id: 'inv1',
  meetingId: 'm1',
  inviteeName: 'ضيف',
  tokenHash: 'x',
  expiresAt: at(60 + 24 * 60),
  revokedAt: null,
  claimedByUserId: null,
  claimedAt: null,
  lastOpenedAt: null,
  meeting: meeting(),
  ...over,
})

function fakeDb(inv: any) {
  const state = { inv: { ...inv }, attendance: null as any, updates: 0, notes: [] as any[], minutes: null as any, events: [] as any[] }
  return {
    state,
    adminMeetingNote: {
      create: async ({ data }: any) => {
        const note = { id: `n${state.notes.length + 1}`, createdAt: new Date(), ...data }
        state.notes.push(note)
        return note
      },
      findMany: async () => state.notes,
    },
    adminMeetingAgentEvent: {
      count: async ({ where }: any) => state.events.filter((e) => e.kind === where.kind).length,
      create: async ({ data }: any) => {
        state.events.push(data)
        return data
      },
    },
    adminMeetingMinutes: {
      findUnique: async () => state.minutes,
      create: async ({ data }: any) => {
        state.minutes = { id: 'min1', ...data }
        return state.minutes
      },
      update: async ({ data }: any) => {
        state.minutes = { ...state.minutes, ...data }
        return state.minutes
      },
    },
    user: { findMany: async () => [] },
    adminMeetingInvite: {
      findUnique: async () => state.inv,
      findMany: async () => [{ inviteeName: state.inv.inviteeName }],
      update: async ({ data }: any) => {
        Object.assign(state.inv, data)
        return state.inv
      },
      updateMany: async ({ where, data }: any) => {
        if (where.claimedByUserId === null && state.inv.claimedByUserId) return { count: 0 }
        Object.assign(state.inv, data)
        state.updates += 1
        return { count: 1 }
      },
    },
    adminMeetingAttendance: {
      findUnique: async () => state.attendance,
      findMany: async () => (state.attendance ? [state.attendance] : []),
      upsert: async ({ create }: any) => {
        if (!state.attendance) state.attendance = { ...create }
        return state.attendance
      },
    },
  }
}

const visitor = { id: 'u-visitor', role: 'VISITOR', name: 'ضيف' }
const other = { id: 'u-other', role: 'STUDENT', name: 'غيره' }

describe('tokens & window & validation', () => {
  test('token hash is not the token; tokens unique', () => {
    const a = generateMeetingToken()
    const b = generateMeetingToken()
    expect(a).not.toBe(b)
    expect(hashMeetingToken(a)).not.toBe(a)
    expect(hashMeetingToken(a)).toBe(hashMeetingToken(a))
  })

  test('join window: −16 closed, −15 open, −14 open, end open, after end closed', () => {
    const m = meeting()
    const realNow = Date.now
    const withNow = (d: Date) => {
      // isMeetingJoinOpen takes an explicit now
      return isMeetingJoinOpen(m, d)
    }
    expect(withNow(at(-16))).toBe(false)
    expect(withNow(at(-15))).toBe(true)
    expect(withNow(at(-14))).toBe(true)
    expect(withNow(at(60))).toBe(true)
    expect(withNow(at(61))).toBe(false)
    expect(isMeetingJoinOpen(meeting({ status: 'CANCELLED' }), at(0))).toBe(false)
    expect(realNow).toBeDefined()
  })

  test('effective status derives from the clock', () => {
    expect(deriveMeetingStatus(meeting(), at(-30))).toBe('SCHEDULED')
    expect(deriveMeetingStatus(meeting(), at(10))).toBe('LIVE')
    expect(deriveMeetingStatus(meeting(), at(90))).toBe('ENDED')
    expect(deriveMeetingStatus(meeting({ status: 'CANCELLED' }), at(10))).toBe('CANCELLED')
  })

  test('invite problems', () => {
    expect(meetingInviteProblem(null)).toBe('NOT_FOUND')
    expect(meetingInviteProblem(invite({ revokedAt: new Date() }))).toBe('REVOKED')
    expect(meetingInviteProblem(invite(), at(60 + 24 * 60 + 1))).toBe('EXPIRED')
    expect(meetingInviteProblem(invite())).toBeNull()
  })

  test('video validation: https only + provider hosts', () => {
    expect(validateMeetingVideo({ provider: 'ZOOM', meetingUrl: 'https://zoom.us/j/1' }).ok).toBe(true)
    expect(validateMeetingVideo({ provider: 'ZOOM', meetingUrl: 'http://zoom.us/j/1' }).ok).toBe(false)
    expect(validateMeetingVideo({ provider: 'ZOOM', meetingUrl: '' }).ok).toBe(false)
    expect(validateMeetingVideo({ provider: 'MEET', meetingUrl: 'https://meet.google.com/abc-defg-hij' }).ok).toBe(true)
    expect(validateMeetingVideo({ provider: 'MEET', meetingUrl: 'https://zoom.us/j/1' }).ok).toBe(false)
    expect(validateMeetingVideo({ provider: 'PLATFORM' }).ok).toBe(true)
    expect(validateMeetingVideo({ provider: 'TEAMS', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x' }).ok).toBe(true)
    expect(validateMeetingVideo({ provider: 'OTHER', meetingUrl: 'https://example.com/room' }).ok).toBe(true)
    expect(validateMeetingVideo({ provider: 'BOGUS', meetingUrl: 'https://x.com' }).ok).toBe(false)
  })

  test('access levels', async () => {
    expect((await meetingAccessFor(null, invite(), null)).level).toBe('TEASER')
    expect((await meetingAccessFor(null, invite(), visitor)).level).toBe('CLAIMABLE')
    expect((await meetingAccessFor(null, invite({ claimedByUserId: visitor.id }), visitor)).level).toBe('FULL')
    expect((await meetingAccessFor(null, invite({ claimedByUserId: other.id }), visitor)).level).toBe('NONE')
    expect((await meetingAccessFor(null, invite({ claimedByUserId: other.id }), { id: 'a', role: 'ADMIN' })).level).toBe('FULL')
  })
})

describe('entry state & actions (fake db)', () => {
  test('logged-out sees a teaser without the agenda', async () => {
    const db = fakeDb(invite())
    const res = await meetingState(db as any, db.state.inv, null)
    expect(res.body.level).toBe('TEASER')
    expect((res.body.meeting as any).agenda).toBeUndefined()
    expect((res.body.meeting as any).title).toBe('اجتماع الإدارة')
  })

  test('revoked invite shows nothing', async () => {
    const db = fakeDb(invite({ revokedAt: new Date() }))
    const res = await meetingState(db as any, db.state.inv, visitor)
    expect(res.body.level).toBe('NONE')
  })

  test('claim binds the invite; another account cannot steal it', async () => {
    const db = fakeDb(invite())
    const claimed = await meetingAction(db as any, db.state.inv, visitor, 'claim')
    expect(claimed.status).toBe(200)
    expect(db.state.inv.claimedByUserId).toBe(visitor.id)
    const steal = await meetingAction(db as any, db.state.inv, other, 'claim')
    expect(steal.status).toBe(403)
  })

  test('join before the window is refused by the server; at start −0 it reveals and records JOINED', async () => {
    const inv = invite({ claimedByUserId: visitor.id })
    inv.meeting = meeting({ startsAt: new Date(Date.now() + 16 * 60_000), endsAt: new Date(Date.now() + 76 * 60_000) })
    const db = fakeDb(inv)
    const early = await meetingAction(db as any, db.state.inv, visitor, 'join')
    expect(early.status).toBe(403)
    expect((early.body as any).code).toBe('JOIN_WINDOW_CLOSED')
    db.state.inv.meeting = meeting({ startsAt: new Date(Date.now() - 5 * 60_000), endsAt: new Date(Date.now() + 55 * 60_000) })
    const ok = await meetingAction(db as any, db.state.inv, visitor, 'join')
    expect(ok.status).toBe(200)
    expect((ok.body as any).meetingUrl).toContain('zoom.us')
    expect(db.state.attendance?.status).toBe('JOINED')
  })

  test('minutes draft from real inputs only; approved minutes are locked', async () => {
    const db = fakeDb(invite({ claimedByUserId: visitor.id }))
    const res = await generateMinutesDraft(db as any, meeting(), 'admin-1')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.minutes.status).toBe('DRAFT')
      // بلا ملاحظات مشاركين: المصدر جدول الأعمال والحضور فقط،
      // وأقسام القرارات/المهام فارغة — لا اختراع
      expect(res.minutes.generatedFrom).toBe('AGENDA_AND_ATTENDANCE')
      expect(res.minutes.decisions).toBeNull()
      expect(res.minutes.actionItems).toBeNull()
    }
    db.state.minutes = { ...db.state.minutes, status: 'APPROVED' }
    const locked = await generateMinutesDraft(db as any, meeting(), 'admin-1')
    expect(locked.ok).toBe(false)
  })

  test('participant notes are stored with the author name; unclaimed cannot write', async () => {
    const inv = invite({ claimedByUserId: visitor.id })
    const db = fakeDb(inv)
    const ok = await meetingAction(db as any, db.state.inv, visitor, 'note', { text: 'اتفقنا على مراجعة الخطة' })
    expect(ok.status).toBe(200)
    expect(db.state.notes.length).toBe(1)
    expect(db.state.notes[0].authorName).toBe('ضيف')
    const db2 = fakeDb(invite())
    const denied = await meetingAction(db2 as any, db2.state.inv, visitor, 'note', { text: 'x' })
    expect(denied.status).toBe(403)
  })

  test('assistant: disabled flag refuses; outside the live window refuses', async () => {
    const inv = invite({ claimedByUserId: visitor.id })
    const db = fakeDb(inv)
    const disabled = await meetingAction(db as any, db.state.inv, visitor, 'ask', { question: 'ما جدول الأعمال؟' })
    expect(disabled.status).toBe(403)
    expect((disabled.body as any).code).toBe('ASSISTANT_DISABLED')

    const inv2 = invite({ claimedByUserId: visitor.id })
    inv2.meeting = meeting({ aiAssistantEnabled: true, startsAt: new Date(Date.now() + 3 * 60 * 60_000), endsAt: new Date(Date.now() + 4 * 60 * 60_000) })
    const db2 = fakeDb(inv2)
    const notLive = await meetingAction(db2 as any, db2.state.inv, visitor, 'ask', { question: 'سؤال' })
    expect(notLive.status).toBe(403)
    expect((notLive.body as any).code).toBe('NOT_LIVE')
  })

  test('join requires claim first; PLATFORM join returns room; cancelled meeting refuses', async () => {
    const dbA = fakeDb(invite())
    const unclaimed = await meetingAction(dbA as any, dbA.state.inv, visitor, 'join')
    expect(unclaimed.status).toBe(403)
    expect((unclaimed.body as any).code).toBe('NOT_CLAIMED')

    const invP = invite({ claimedByUserId: visitor.id })
    invP.meeting = meeting({ provider: 'PLATFORM', meetingUrl: null, startsAt: new Date(Date.now() - 1 * 60_000), endsAt: new Date(Date.now() + 59 * 60_000) })
    const dbP = fakeDb(invP)
    const room = await meetingAction(dbP as any, dbP.state.inv, visitor, 'join')
    expect((room.body as any).room).toBe(true)

    const invC = invite({ claimedByUserId: visitor.id })
    invC.meeting = meeting({ status: 'CANCELLED', startsAt: new Date(Date.now() - 1 * 60_000), endsAt: new Date(Date.now() + 59 * 60_000) })
    const dbC = fakeDb(invC)
    const cancelled = await meetingAction(dbC as any, dbC.state.inv, visitor, 'join')
    expect(cancelled.status).toBe(409)
  })
})
