// قاعة الاجتماعات — اختبارات المنطق والدخول بفاكس في الذاكرة.
// التشغيل: bun test tests/meetings/admin-meetings.test.ts (منفردًا —
// المُحاكاة تتسرب بين الملفات).
import { describe, expect, mock, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'

mock.module('@/lib/rate-limit', () => ({
  checkDatabaseRateLimit: async () => ({ allowed: true, ok: true }),
}))

// بيئة الخادم اللازمة لروابط الدعوات والنسخ المشفّرة (تُقرأ عند
// الاستدعاء لا عند الاستيراد، فيكفي ضبطها هنا).
process.env.NEXT_PUBLIC_APP_URL = 'https://academy.test'
process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

// قاعدة وهمية لمسار تفاصيل اجتماع الإدارة + بوابة إدارية قابلة للقلب
const routeAdmin = { current: true }
const routeMeeting = { current: null as any }
const routeDeletedIds: string[] = []
const routeAudits: any[] = []
const roomPeerOwner = { current: null as string | null }
const roomSignalsConsumed = { count: 0 }
const roomAttendanceWrites = { count: 0 }
const roomTransaction = { attempts: 0, conflictsRemaining: 0, isolationLevel: '' }
const roomInvite = {
  id: 'room-invite-1',
  inviteeName: 'Participant',
  claimedByUserId: 'room-user-1',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  meeting: {
    id: 'room-meeting-1',
    provider: 'PLATFORM',
    status: 'SCHEDULED',
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60 * 60_000),
  },
}
const roomSignalStore = {
  findFirst: async () => roomPeerOwner.current
    ? { id: 'presence-1', payload: JSON.stringify({ userId: roomPeerOwner.current, name: 'Participant' }) }
    : null,
  findMany: async ({ where }: any) => where.type === 'PRESENCE'
    ? []
    : [{ id: 'signal-1', fromPeer: 'another-peer', toPeer: 'p_target', type: 'ICE', payload: '{}', consumed: false }],
  updateMany: async () => { roomSignalsConsumed.count++; return { count: 1 } },
  deleteMany: async ({ where }: any) => {
    if (where.fromPeer) roomPeerOwner.current = null
    return { count: 1 }
  },
  create: async ({ data }: any) => {
    roomPeerOwner.current = JSON.parse(data.payload).userId
    return { id: 'presence-new', ...data }
  },
}
mock.module('@/lib/db', () => ({
  db: {
    adminMeeting: {
      findUnique: async () => routeMeeting.current,
      // الحذف يزيل الصف نفسه؛ في قاعدة البيانات الحقيقية يزيل معه
      // كل ما يتفرع عنه (الدعوات والحضور...) عبر onDelete: Cascade —
      // والوهمية تمثّل ذلك بأن الصف وكل ما تحته يختفي من أي وصول لاحق.
      delete: async ({ where }: any) => {
        routeDeletedIds.push(where.id)
        const removed = routeMeeting.current
        routeMeeting.current = null
        return removed
      },
    },
    user: { findMany: async () => [] },
    adminMeetingInvite: { findUnique: async () => roomInvite },
    adminMeetingAttendance: { upsert: async () => { roomAttendanceWrites.count++ } },
    adminMeetingSignal: roomSignalStore,
    $transaction: async (work: any, options: any) => {
      roomTransaction.attempts++
      roomTransaction.isolationLevel = options?.isolationLevel || ''
      if (roomTransaction.conflictsRemaining > 0) {
        roomTransaction.conflictsRemaining--
        throw Object.assign(new Error('serialization conflict'), { code: 'P2034' })
      }
      return work({ adminMeetingSignal: roomSignalStore })
    },
  },
}))
mock.module('@/lib/settings', () => ({ getSettings: async () => ({}) }))
mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => ({ id: 'room-user-1', role: 'STUDENT', name: 'Participant' }),
  requireAdmin: async () => {
    if (!routeAdmin.current) throw new Error('FORBIDDEN')
    return { id: 'admin-1', name: 'المسؤول' }
  },
}))
mock.module('@/lib/notify', () => ({
  audit: async (...args: any[]) => {
    routeAudits.push(args)
  },
}))

const {
  generateMeetingToken,
  hashMeetingToken,
  isMeetingJoinOpen,
  deriveMeetingStatus,
  meetingInviteProblem,
  validateMeetingVideo,
  meetingAccessFor,
  sealMeetingToken,
  meetingInviteUrl,
  meetingInviteUrlForInvite,
  rotateMeetingInviteToken,
  findMeetingInviteByToken,
  adminInviteShape,
} = await import('@/lib/admin-meetings')
const { meetingState, meetingAction } = await import('@/lib/meeting-entry')
const { generateMinutesDraft } = await import('@/lib/meeting-minutes')
const { collectMeetingAcademyEvidence } = await import('@/lib/meeting-assistant')
const adminMeetingDetailRoute = await import('@/app/api/admin/meetings/[id]/route')
const meetingRoomRoute = await import('@/app/api/meetings/[token]/room/route')

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

  test('claimable (logged-in, not yet claimed) sees the teaser only — no description, agenda or invitee names', async () => {
    const db = fakeDb(invite())
    const res = await meetingState(db as any, db.state.inv, visitor)
    expect(res.body.level).toBe('CLAIMABLE')
    const m = res.body.meeting as any
    expect(m.title).toBe('اجتماع الإدارة')
    expect(m.hostName).toBe('الإدارة')
    expect(m.description).toBeUndefined()
    expect(m.agenda).toBeUndefined()
    expect(m.inviteeNames).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('جدول سري')
    expect((res.body as any).myInvite?.inviteeName).toBe('ضيف')
  })

  test('claimed (FULL) still receives description, agenda and invitee names', async () => {
    const db = fakeDb(invite({ claimedByUserId: visitor.id }))
    const res = await meetingState(db as any, db.state.inv, visitor)
    expect(res.body.level).toBe('FULL')
    const m = res.body.meeting as any
    expect(m.description).toBe('وصف')
    expect(m.agenda).toBe('جدول سري')
    expect(m.inviteeNames).toEqual(['ضيف'])
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

  test('Zoom SDK signature is scoped, verifiable, and never bypasses meeting access', async () => {
    const oldKey = process.env.ZOOM_MEETING_SDK_CLIENT_ID
    const oldSecret = process.env.ZOOM_MEETING_SDK_CLIENT_SECRET
    process.env.ZOOM_MEETING_SDK_CLIENT_ID = 'test-sdk-key'
    process.env.ZOOM_MEETING_SDK_CLIENT_SECRET = 'test-sdk-secret'
    try {
      const active = meeting({
        meetingUrl: 'https://us05web.zoom.us/j/89713410341?pwd=encrypted-token',
        meetingPasscode: 'actual-passcode',
        startsAt: new Date(Date.now() - 5 * 60_000),
        endsAt: new Date(Date.now() + 55 * 60_000),
      })
      const inv = invite({ claimedByUserId: visitor.id, meeting: active })
      const db = fakeDb(inv)
      const joined = await meetingAction(db as any, db.state.inv, visitor, 'join')
      expect(joined.status).toBe(200)
      const sdk = (joined.body as any).zoomSdk
      expect(sdk?.meetingNumber).toBe('89713410341')
      expect(sdk?.sdkKey).toBe('test-sdk-key')
      expect(sdk?.password).toBe('actual-passcode')
      const parts = sdk.signature.split('.')
      expect(parts).toHaveLength(3)
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
      expect(header.alg).toBe('HS256')
      expect(claims.sdkKey).toBe('test-sdk-key')
      expect(claims.mn).toBe('89713410341')
      expect(claims.role).toBe(0)
      expect(claims.exp).toBeGreaterThan(claims.iat)
      expect(parts[2]).toBe(createHmac('sha256', 'test-sdk-secret').update(parts[0] + '.' + parts[1]).digest('base64url'))
      expect(sdk.signature).not.toContain('test-sdk-secret')

      const unclaimed = await meetingAction(db as any, db.state.inv, other, 'join')
      expect(unclaimed.status).toBe(403)
      expect((unclaimed.body as any).zoomSdk).toBeUndefined()

      db.state.inv.meeting = { ...active, startsAt: new Date(Date.now() + 16 * 60_000), endsAt: new Date(Date.now() + 76 * 60_000) }
      const early = await meetingAction(db as any, db.state.inv, visitor, 'join')
      expect(early.status).toBe(403)
      expect((early.body as any).zoomSdk).toBeUndefined()

      db.state.inv.meeting = active
      delete process.env.ZOOM_MEETING_SDK_CLIENT_SECRET
      const fallback = await meetingAction(db as any, db.state.inv, visitor, 'join')
      expect(fallback.status).toBe(200)
      expect((fallback.body as any).zoomSdk).toBeUndefined()
      expect((fallback.body as any).meetingUrl).toBe(active.meetingUrl)
    } finally {
      if (oldKey === undefined) delete process.env.ZOOM_MEETING_SDK_CLIENT_ID
      else process.env.ZOOM_MEETING_SDK_CLIENT_ID = oldKey
      if (oldSecret === undefined) delete process.env.ZOOM_MEETING_SDK_CLIENT_SECRET
      else process.env.ZOOM_MEETING_SDK_CLIENT_SECRET = oldSecret
    }
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
    // الاجتماع حيّ الآن (داخل نافذة الدخول) — فرضية الاختبار الأصلية:
    // ملاحظة مشارك أثناء الاجتماع تُحفظ.
    inv.meeting = meeting({ startsAt: new Date(Date.now() - 5 * 60_000), endsAt: new Date(Date.now() + 55 * 60_000) })
    const db = fakeDb(inv)
    const ok = await meetingAction(db as any, db.state.inv, visitor, 'note', { text: 'اتفقنا على مراجعة الخطة' })
    expect(ok.status).toBe(200)
    expect(db.state.notes.length).toBe(1)
    expect(db.state.notes[0].authorName).toBe('ضيف')
    const inv2 = invite()
    inv2.meeting = meeting({ startsAt: new Date(Date.now() - 5 * 60_000), endsAt: new Date(Date.now() + 55 * 60_000) })
    const db2 = fakeDb(inv2)
    const denied = await meetingAction(db2 as any, db2.state.inv, visitor, 'note', { text: 'x' })
    expect(denied.status).toBe(403)
    expect((denied.body as any).code).toBe('NOT_CLAIMED')
    expect(db2.state.notes.length).toBe(0)
  })

  test('notes are refused outside the join window and never stored; reading them stays open', async () => {
    // قبل فتح النافذة (الاجتماع بعد ساعة): رفض + لا حفظ
    const invEarly = invite({ claimedByUserId: visitor.id })
    invEarly.meeting = meeting({ startsAt: new Date(Date.now() + 60 * 60_000), endsAt: new Date(Date.now() + 120 * 60_000) })
    const dbEarly = fakeDb(invEarly)
    const early = await meetingAction(dbEarly as any, dbEarly.state.inv, visitor, 'note', { text: 'ملاحظة مبكرة' })
    expect(early.status).toBe(403)
    expect((early.body as any).code).toBe('JOIN_WINDOW_CLOSED')
    expect(dbEarly.state.notes.length).toBe(0)

    // داخل النافذة (قبل البدء بـ10 دقائق): تُحفظ
    const invLive = invite({ claimedByUserId: visitor.id })
    invLive.meeting = meeting({ startsAt: new Date(Date.now() + 10 * 60_000), endsAt: new Date(Date.now() + 70 * 60_000) })
    const dbLive = fakeDb(invLive)
    const live = await meetingAction(dbLive as any, dbLive.state.inv, visitor, 'note', { text: 'ملاحظة أثناء الاجتماع' })
    expect(live.status).toBe(200)
    expect(dbLive.state.notes.length).toBe(1)
    expect(dbLive.state.notes[0].text).toBe('ملاحظة أثناء الاجتماع')

    // بعد انتهاء الاجتماع: رفض + لا حفظ
    const invLate = invite({ claimedByUserId: visitor.id })
    invLate.meeting = meeting({ startsAt: new Date(Date.now() - 120 * 60_000), endsAt: new Date(Date.now() - 60 * 60_000) })
    const dbLate = fakeDb(invLate)
    const late = await meetingAction(dbLate as any, dbLate.state.inv, visitor, 'note', { text: 'ملاحظة متأخرة' })
    expect(late.status).toBe(403)
    expect((late.body as any).code).toBe('JOIN_WINDOW_CLOSED')
    expect(dbLate.state.notes.length).toBe(0)

    // القراءة بعد الانتهاء تبقى مسموحة لصاحب الوصول الكامل
    dbLate.state.notes.push({ id: 'n-old', meetingId: 'm1', userId: visitor.id, authorName: 'ضيف', text: 'ملاحظة قديمة', createdAt: new Date() })
    const state = await meetingState(dbLate as any, dbLate.state.inv, visitor)
    expect(state.body.level).toBe('FULL')
    expect((state.body.notes as any[]).length).toBe(1)
    expect((state.body.notes as any[])[0].text).toBe('ملاحظة قديمة')
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

  test('guest-facing state never exposes invite URLs or sealed tokens', async () => {
    const inv = invite({ claimedByUserId: visitor.id, tokenSealed: sealMeetingToken('raw-token-xyz') })
    const db = fakeDb(inv)
    const teaser = await meetingState(db as any, db.state.inv, null)
    expect(JSON.stringify(teaser.body)).not.toContain('/meetings/')
    expect(JSON.stringify(teaser.body)).not.toContain('tokenSealed')
    expect((teaser.body as any).myInvite?.inviteeName).toBe('ضيف')
    const full = await meetingState(db as any, db.state.inv, visitor)
    expect(JSON.stringify(full.body)).not.toContain('/meetings/')
    expect(JSON.stringify(full.body)).not.toContain('tokenSealed')
    expect(JSON.stringify(full.body)).not.toContain('raw-token-xyz')
  })
})

function fakeInviteDb(inv: any) {
  const state = { inv: { ...inv } }
  return {
    state,
    adminMeetingInvite: {
      findUnique: async ({ where }: any) =>
        where?.tokenHash && where.tokenHash === state.inv.tokenHash ? { ...state.inv, meeting: meeting() } : null,
      update: async ({ data }: any) => {
        Object.assign(state.inv, data)
        return state.inv
      },
    },
  }
}

describe('persistent invite links (sealed tokens)', () => {
  test('sealed token is stored encrypted; admin shape rebuilds the exact creation URL', () => {
    const token = generateMeetingToken()
    const sealed = sealMeetingToken(token)
    expect(sealed).not.toBeNull()
    expect(sealed).not.toBe(token)
    expect(String(sealed)).toStartWith('enc:v1:')
    expect(meetingInviteUrlForInvite({ tokenSealed: sealed })).toBe(meetingInviteUrl(token))
    expect(meetingInviteUrl(token)).toBe(`https://academy.test/meetings/${token}`)
    const shaped = adminInviteShape(invite({ tokenSealed: sealed }), null, T0)
    expect(shaped.url).toBe(`https://academy.test/meetings/${token}`)
    // دعوة قديمة بلا نسخة مشفّرة: لا رابط (تُعالج بإعادة الإصدار)
    expect(meetingInviteUrlForInvite({ tokenSealed: null })).toBeNull()
    expect(adminInviteShape(invite({ tokenSealed: null }), null, T0).url).toBeNull()
  })

  test('without a server encryption key nothing raw is stored — link stays one-time', () => {
    const saved = process.env.AACT_SECRETS_KEY
    delete process.env.AACT_SECRETS_KEY
    try {
      expect(sealMeetingToken(generateMeetingToken())).toBeNull()
    } finally {
      process.env.AACT_SECRETS_KEY = saved
    }
  })

  test('legacy rotation: new link works, old link dies, sealed copy matches the new link', async () => {
    const oldToken = generateMeetingToken()
    const db = fakeInviteDb(invite({ tokenHash: hashMeetingToken(oldToken), tokenSealed: null }))
    const rotated = await rotateMeetingInviteToken(db as any, db.state.inv)
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    const newToken = rotated.url.split('/meetings/')[1]
    expect(newToken).toBeTruthy()
    expect(newToken).not.toBe(oldToken)
    // الرابط القديم ميت: هاشه لم يعد يطابق أي دعوة
    expect(await findMeetingInviteByToken(db as any, oldToken)).toBeNull()
    // الرابط الجديد حيّ ويحل إلى نفس الدعوة
    const found = await findMeetingInviteByToken(db as any, newToken)
    expect(found?.id).toBe('inv1')
    // والنسخة المشفّرة المحفوظة تعيد بناء الرابط الجديد نفسه لعرض الإدارة
    expect(db.state.inv.tokenSealed).not.toBeNull()
    expect(meetingInviteUrlForInvite(db.state.inv)).toBe(rotated.url)
  })

  test('claimed invite refuses rotation and keeps its hash; revoked refuses too', async () => {
    const token = generateMeetingToken()
    const claimedDb = fakeInviteDb(invite({ tokenHash: hashMeetingToken(token), claimedByUserId: visitor.id }))
    const refused = await rotateMeetingInviteToken(claimedDb as any, claimedDb.state.inv)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('ALREADY_CLAIMED')
    expect(claimedDb.state.inv.tokenHash).toBe(hashMeetingToken(token))

    const revokedDb = fakeInviteDb(invite({ tokenHash: hashMeetingToken(token), revokedAt: new Date() }))
    const refused2 = await rotateMeetingInviteToken(revokedDb as any, revokedDb.state.inv)
    expect(refused2.ok).toBe(false)
    if (!refused2.ok) expect(refused2.code).toBe('INVITE_REVOKED')
    expect(revokedDb.state.inv.tokenHash).toBe(hashMeetingToken(token))
  })

  test('admin detail endpoint returns the URL to admins only', async () => {
    const token = generateMeetingToken()
    const sealed = sealMeetingToken(token)
    routeMeeting.current = {
      ...meeting(),
      invites: [{ ...invite({ tokenSealed: sealed }), meeting: undefined }],
      attendance: [],
    }
    routeAdmin.current = true
    const okRes = await adminMeetingDetailRoute.GET(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(okRes.status).toBe(200)
    const okBody = await okRes.json()
    expect(okBody.invites[0].url).toBe(`https://academy.test/meetings/${token}`)
    expect(JSON.stringify(okBody)).not.toContain('tokenSealed')
    expect(JSON.stringify(okBody)).not.toContain(String(sealed))

    routeAdmin.current = false
    const deniedRes = await adminMeetingDetailRoute.GET(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(deniedRes.status).toBe(403)
    const deniedBody = await deniedRes.json()
    expect(JSON.stringify(deniedBody)).not.toContain('/meetings/')
    expect(JSON.stringify(deniedBody)).not.toContain(token)
    routeAdmin.current = true
    routeMeeting.current = null
  })
})

describe('entry state & actions (fake db)', () => {
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

async function pollRoom(peerId?: string) {
  const url = 'https://academy.test/api/meetings/valid-token/room'
    + (peerId ? '?peerId=' + encodeURIComponent(peerId) : '')
  return meetingRoomRoute.GET(new NextRequest(url), {
    params: Promise.resolve({ token: 'valid-token' }),
  })
}

async function postRoom(action: 'join' | 'heartbeat', peerId = 'p_target') {
  return meetingRoomRoute.POST(
    new NextRequest('https://academy.test/api/meetings/valid-token/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, peerId, name: 'Participant' }),
    }),
    { params: Promise.resolve({ token: 'valid-token' }) },
  )
}

describe('meeting-room signal ownership', () => {
  test('missing peer presence refuses signal polling without consuming messages', async () => {
    roomPeerOwner.current = null
    roomSignalsConsumed.count = 0
    roomAttendanceWrites.count = 0
    const response = await pollRoom('p_target')
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('FORBIDDEN_PEER')
    expect(roomSignalsConsumed.count).toBe(0)
    expect(roomAttendanceWrites.count).toBe(0)
  })

  test('a peer belonging to another user cannot consume that peer messages', async () => {
    roomPeerOwner.current = 'room-user-2'
    roomSignalsConsumed.count = 0
    const response = await pollRoom('p_target')
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('FORBIDDEN_PEER')
    expect(roomSignalsConsumed.count).toBe(0)
  })

  test('the owner of a joined peer can poll its signalling messages', async () => {
    roomPeerOwner.current = 'room-user-1'
    roomSignalsConsumed.count = 0
    roomAttendanceWrites.count = 0
    const response = await pollRoom('p_target')
    expect(response.status).toBe(200)
    expect((await response.json()).signals).toHaveLength(1)
    expect(roomSignalsConsumed.count).toBe(1)
    expect(roomAttendanceWrites.count).toBe(1)
  })

  test('peer discovery without peerId remains available to the invite owner', async () => {
    roomPeerOwner.current = null
    roomSignalsConsumed.count = 0
    const response = await pollRoom()
    expect(response.status).toBe(200)
    expect(roomSignalsConsumed.count).toBe(0)
  })
  test('join claims peer using a serializable transaction before recording attendance', async () => {
    roomPeerOwner.current = null
    roomTransaction.attempts = 0
    roomTransaction.conflictsRemaining = 0
    roomTransaction.isolationLevel = ''
    roomAttendanceWrites.count = 0
    const response = await postRoom('join')
    expect(response.status).toBe(200)
    expect(roomTransaction.isolationLevel).toBe('Serializable')
    expect(roomTransaction.attempts).toBe(1)
    expect(String(roomPeerOwner.current)).toBe('room-user-1')
    expect(roomAttendanceWrites.count).toBe(1)
  })

  test('an already-claimed peer cannot be stolen by a new join', async () => {
    roomPeerOwner.current = 'room-user-2'
    roomTransaction.attempts = 0
    roomAttendanceWrites.count = 0
    const response = await postRoom('join')
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('PEER_IN_USE')
    expect(roomPeerOwner.current).toBe('room-user-2')
    expect(roomAttendanceWrites.count).toBe(0)
  })

  test('serialization conflict retries and then records a successful join', async () => {
    roomPeerOwner.current = null
    roomTransaction.attempts = 0
    roomTransaction.conflictsRemaining = 1
    const response = await postRoom('join')
    expect(response.status).toBe(200)
    expect(roomTransaction.attempts).toBe(2)
    expect(String(roomPeerOwner.current)).toBe('room-user-1')
  })

  test('repeated serialization conflicts return retryable 409 without stealing a peer', async () => {
    roomPeerOwner.current = null
    roomTransaction.attempts = 0
    roomTransaction.conflictsRemaining = 3
    const response = await postRoom('join')
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('PEER_CONFLICT')
    expect(roomTransaction.attempts).toBe(3)
    expect(roomPeerOwner.current).toBeNull()
  })

  test('heartbeat must own its peer and uses the same serializable path', async () => {
    roomPeerOwner.current = null
    roomTransaction.conflictsRemaining = 0
    expect((await postRoom('heartbeat')).status).toBe(403)
    roomPeerOwner.current = 'room-user-1'
    roomTransaction.attempts = 0
    const response = await postRoom('heartbeat')
    expect(response.status).toBe(200)
    expect(roomTransaction.attempts).toBe(1)
    expect(roomTransaction.isolationLevel).toBe('Serializable')
  })
})

describe('admin meeting hard delete (route level)', () => {
  test('admin delete removes the meeting and writes the audit; afterwards the detail 404s', async () => {
    routeAdmin.current = true
    routeDeletedIds.length = 0
    routeAudits.length = 0
    routeMeeting.current = { ...meeting(), invites: [invite()], attendance: [] }
    const res = await adminMeetingDetailRoute.DELETE(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.deleted).toBe(true)
    expect(routeDeletedIds).toEqual(['m1'])
    // أثر التدقيق يحمل فعل الحذف وعنوان الاجتماع المحذوف
    const del = routeAudits.find((a) => a[1] === 'ADMIN_MEETING_DELETED')
    expect(del).toBeTruthy()
    expect(del?.[2]).toBe('AdminMeeting')
    expect(del?.[3]).toBe('m1')
    expect(String(del?.[4])).toContain('title=اجتماع الإدارة')
    // الصف اختفى بكل ما كان متدليًا منه (الدعوات nested تحته في
    // الوهمية كما تتفرع عنه في الحقيقية): التفاصيل الآن 404
    const gone = await adminMeetingDetailRoute.GET(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(gone.status).toBe(404)
    routeMeeting.current = null
  })

  test('a cancelled meeting can still be hard-deleted (no status restriction)', async () => {
    routeAdmin.current = true
    routeDeletedIds.length = 0
    routeMeeting.current = { ...meeting({ status: 'CANCELLED' }), invites: [], attendance: [] }
    const res = await adminMeetingDetailRoute.DELETE(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(res.status).toBe(200)
    expect(routeDeletedIds).toEqual(['m1'])
    routeMeeting.current = null
  })

  test('non-admin cannot delete: 403 and nothing is removed', async () => {
    routeDeletedIds.length = 0
    routeMeeting.current = { ...meeting(), invites: [], attendance: [] }
    routeAdmin.current = false
    const res = await adminMeetingDetailRoute.DELETE(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'm1' }),
    })
    expect(res.status).toBe(403)
    expect(routeDeletedIds).toEqual([])
    expect(routeMeeting.current?.id).toBe('m1')
    routeAdmin.current = true
    routeMeeting.current = null
  })

  test('deleting a missing meeting 404s and deletes nothing', async () => {
    routeAdmin.current = true
    routeDeletedIds.length = 0
    routeMeeting.current = null
    const res = await adminMeetingDetailRoute.DELETE(new Request('https://academy.test') as any, {
      params: Promise.resolve({ id: 'missing' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('الاجتماع غير موجود')
    expect(routeDeletedIds).toEqual([])
  })
})


describe('dedicated voice participant scope and minutes integrity', () => {
  const liveInvite = () => {
    const now = Date.now()
    return invite({
      claimedByUserId: visitor.id,
      meeting: meeting({
        provider: 'PLATFORM', meetingUrl: null,
        aiAssistantEnabled: true, minutesEnabled: true,
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 60 * 60_000),
      }),
    })
  }
  test('guest cannot create a voice session, query admin data or log AI turns', async () => {
    const db = fakeDb(liveInvite())
    for (const action of ['voice-session', 'live-data', 'live-turn']) {
      const result = await meetingAction(db as any, db.state.inv, visitor, action, {
        question: 'نتيجة الطالب جميل ناصر', userText: 'نتيجة', aiText: 'تعليق',
      })
      expect(result.status).toBe(403)
      expect((result.body as any).code).toBe('MEETING_AGENT_ADMIN_REQUIRED')
    }
    expect(db.state.events).toHaveLength(0)
  })
  test('only authorized admins see the independent bot switch', async () => {
    const db = fakeDb(liveInvite())
    const guest = await meetingState(db as any, db.state.inv, visitor)
    expect((guest.body as any).canOperateAi).toBe(false)
    const admin = await meetingState(db as any, db.state.inv, { id: 'admin-1', role: 'ADMIN', name: 'مسؤول' })
    expect((admin.body as any).canOperateAi).toBe(true)
  })
  test('admin data question resolves from meeting-scoped DB with no model SQL', async () => {
    const db = fakeDb(liveInvite())
    const result = await meetingAction(db as any, db.state.inv, { id: 'admin-1', role: 'ADMIN' },
      'live-data', { question: 'نتيجة الطالب جميل ناصر' })
    expect(result.status).toBe(200)
    expect((result.body as any).snippets).toContain('لم يُعثر على طالب')
  })
  test('meeting speech is stored with unknown speaker and AI provenance, never as a formal decision', async () => {
    const db = fakeDb(liveInvite()) as any
    db.adminMeetingAgentEvent.createMany = async ({ data }: any) => {
      db.state.events.push(...data)
      return { count: data.length }
    }
    const result = await meetingAction(db, db.state.inv, { id: 'admin-1', role: 'ADMIN' }, 'live-turn', {
      userText: 'سأراجع خطة البرنامج', aiText: 'أقترح أن نراجع أعداد الطلاب أولاً',
    })
    expect(result.status).toBe(200)
    expect(db.state.events.map((e: any) => e.kind)).toEqual(['TRANSCRIPT', 'AI_SPEECH'])
    expect(db.state.events[0].text).toContain('المتحدث غير محدد')
    expect(db.state.events[1].text).toContain('المشرف الذكي')
  })
})

describe('meeting AI academy evidence is admin-only and current', () => {
  test('a claimed guest or supervisor never triggers an administrative query', async () => {
    const forbiddenDb = new Proxy({}, { get() { throw new Error('UNAUTHORIZED_QUERY') } })
    for (const role of ['STUDENT', 'VISITOR', 'SUPERVISOR']) {
      const context = await collectMeetingAcademyEvidence(forbiddenDb, 'نتيجة الطالب أحمد صالح', { role })
      expect(context).toContain('صلاحيات')
    }
  })

  test('the admin student count comes from a live read and is not a static number', async () => {
    let count = 11
    const fake: any = {
      user: { count: async () => count },
      enrollment: { count: async () => 4 },
      examAttempt: { count: async () => 0 },
      programExamAttempt: { count: async () => 0 },
      programAssignment: { count: async () => 0 },
      assignmentSubmission: { count: async () => 0 },
      payment: { count: async () => 0 },
      book: { count: async () => 0 },
      thesisSubmission: { count: async () => 0 },
      lectureVideoResource: { count: async () => 0 },
      admissionApplication: { count: async () => 0 },
      certificate: { count: async () => 0 },
      program: { findMany: async () => [] },
    }
    const first = await collectMeetingAcademyEvidence(fake, 'كم عدد الطلاب في المنصة؟', { role: 'ADMIN' })
    expect(first).toContain('حسابات الطلاب النشطة: 11')
    count = 14
    const second = await collectMeetingAcademyEvidence(fake, 'كم عدد الطلاب في المنصة؟', { role: 'ADMIN' })
    expect(second).toContain('حسابات الطلاب النشطة: 14')
  })

  test('one selected student returns the stored grade and unit/exam results, without mutations', async () => {
    const fake: any = {
      user: { findMany: async () => [{ id: 's-1', name: 'أحمد صالح', status: 'ACTIVE' }] },
      enrollment: { findMany: async () => [{
        programId: 'p-1', status: 'ACTIVE', completedUnits: '["u-1"]',
        finalScore: 70.5, certificateNo: null,
        program: { titleAr: 'برنامج الإدارة', units: [
          { id: 'u-1', title: 'التخطيط', status: 'APPROVED' },
          { id: 'u-2', title: 'القيادة', status: 'APPROVED' },
        ] },
      }] },
      examAttempt: { findMany: async () => [{ score: 83, passed: true, exam: { title: 'اختبار التخطيط' } }] },
      programExamAttempt: { findMany: async () => [{ score: 60, finalScore: 72, exam: { title: 'الاختبار الفصلي', semester: 1 } }] },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'ما نتائج الطالب أحمد صالح ووحداته؟', { role: 'ADMIN' })
    expect(result).toContain('70.5')
    expect(result).toContain('الوحدات المعتمدة المتبقية: 1')
    expect(result).toContain('اختبار التخطيط=83')
    expect(result).toContain('الاختبار الفصلي (الفصل 1)=72')
  })

  test('an ambiguous student name never mixes two academic records', async () => {
    const fake: any = {
      user: { findMany: async () => [
        { id: 's-1', name: 'أحمد صالح' },
        { id: 's-2', name: 'أحمد صالح' },
      ] },
      enrollment: { findMany: async () => { throw new Error('should not load grades') } },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'نتيجة الطالب أحمد صالح', { role: 'ADMIN' })
    expect(result).toContain('أكثر من سجل')
  })

  test('focused Whatsapp inquiry does not trigger unrelated student or program queries', async () => {
    const count = async () => 7
    const fake: any = {
      contactMessage: { count }, humanHandoffRequest: { count },
      whatsAppConversation: { count }, whatsAppConversationMessage: { count },
      notification: { count }, notificationOutbox: { count }, emailLog: { count },
      studentFollowUpLog: { count }, supervisorChannelMessage: { count },
      user: { count: () => { throw new Error('UNRELATED_STUDENT_QUERY') } },
      program: { findMany: () => { throw new Error('UNRELATED_PROGRAM_QUERY') } },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'ما وضع محادثات واتساب؟', { role: 'ADMIN' })
    expect(result).toContain('محادثات واتساب المسجلة 7')
    expect(result).toContain('رسائل واتساب المسجلة 7')
    expect(result).not.toContain('حسابات الطلاب النشطة')
  })

  test('financial evidence groups actual paid amounts by currency, not mixed revenues', async () => {
    const fake: any = {
      payment: {
        count: async () => 8,
        groupBy: async () => [
          { currency: 'USD', _sum: { amount: 100 }, _count: { _all: 2 } },
          { currency: 'EUR', _sum: { amount: 80 }, _count: { _all: 1 } },
        ],
      },
      paymentWaiverCode: { count: async () => 1 },
      paymentProof: { count: async () => 2 },
      revenueShareTransaction: { count: async () => 3 },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'كم الإيرادات حسب العملة؟', { role: 'ADMIN' })
    expect(result).toContain('USD: 100 (2 سجل)')
    expect(result).toContain('EUR: 80 (1 سجل)')
    expect(result).toContain('ليست أرباحًا صافية')
  })

  test('admissions questions can read latest applications without unrelated areas', async () => {
    const fake: any = {
      admissionApplication: {
        count: async () => 5,
        findMany: async () => [
          { reference: 'A-1', fullName: 'أحمد', program: 'إدارة الأعمال', status: 'UNDER_REVIEW' },
        ],
      },
      serviceDeliverable: { count: async () => 1 },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'آخر طلبات القبول', { role: 'ADMIN' })
    expect(result).toContain('جميع طلبات القبول/الخدمات 5')
    expect(result).toContain('A-1، أحمد، إدارة الأعمال، UNDER_REVIEW')
  })

  test('named student certificate query does not mix with another student', async () => {
    const fake: any = {
      user: { findMany: async () => [{ id: 's-1', name: 'جميل ناصر', status: 'ACTIVE' }] },
      enrollment: { findMany: async () => [] },
      certificate: { findMany: async () => [
        { serial: 'CERT-1', valid: true, revokedAt: null, program: 'الماجستير' },
      ] },
    }
    const result = await collectMeetingAcademyEvidence(fake, 'شهادات الطالب جميل ناصر', { role: 'ADMIN' })
    expect(result).toContain('CERT-1')
    expect(result).toContain('الصلاحية سارية')
  })

  test('database failures propagate instead of converting to zero or fabricated answers', async () => {
    const fake: any = { user: { count: async () => { throw new Error('DB_OFFLINE') } },
      enrollment: { count: async () => 0 }, examAttempt: { count: async () => 0 },
      programExamAttempt: { count: async () => 0 }, programAssignment: { count: async () => 0 },
      assignmentSubmission: { count: async () => 0 }, payment: { count: async () => 0 },
      book: { count: async () => 0 }, thesisSubmission: { count: async () => 0 },
      lectureVideoResource: { count: async () => 0 }, admissionApplication: { count: async () => 0 },
      certificate: { count: async () => 0 }, program: { findMany: async () => [] } }
    await expect(collectMeetingAcademyEvidence(fake, 'كم عدد الطلاب في المنصة؟', { role: 'ADMIN' }))
      .rejects.toThrow('DB_OFFLINE')
  })
})
