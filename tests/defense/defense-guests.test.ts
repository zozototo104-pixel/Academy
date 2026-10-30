// اختبارات حارسة: قاعة المناقشة — بوابة الدخول الجديدة ودعوات المناقشين الخارجيين.
// قرار المالك 2026-10-30: الحاضرون = الطالب صاحب البحث + مشرفه المسند + الأدمن،
// والمناقشون الخارجيون بروابط دعوة شخصية (بلا حساب). أي مشرف آخر لا يدخل إلا بدعوة.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// مفتاح تشفير إعدادات تجريبي (لنفس نمط اختبارات الأمان) لاختبار فك أسرار TURN
process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

let currentUser: any = null
let theses: any[] = []
let applications: any[] = []
let participants: any[] = []
let signals: any[] = []
let invites: any[] = []
let settings: any[] = []
let inviteSeq = 0
let signalSeq = 0

function reset() {
  currentUser = null
  theses = [
    { id: 't1', userId: 'student-1', title: 'بحث التخرج الأول', abstract: 'ملخص', defenseStatus: null, defenseDate: new Date(Date.now() + 86400000), committee: '["د. خارجي"]', agentMember: null, defenseMeetingUrl: null },
  ]
  applications = [{ id: 'a1', supervisorId: 'sup-1', userId: 'student-1' }]
  participants = []
  signals = []
  invites = []
  settings = []
  inviteSeq = 0
  signalSeq = 0
}

const dbMock: any = {
  thesisSubmission: {
    findUnique: async ({ where }: any) => theses.find((t) => t.id === where.id) ?? null,
  },
  admissionApplication: {
    findFirst: async ({ where }: any) =>
      applications.find(
        (a) => (where.supervisorId === undefined || a.supervisorId === where.supervisorId) && (where.userId === undefined || a.userId === where.userId),
      ) ?? null,
  },
  defenseParticipant: {
    findFirst: async ({ where }: any) => participants.find((p) => p.thesisId === where.thesisId && p.peerId === where.peerId) ?? null,
    findUnique: async ({ where }: any) => participants.find((p) => p.peerId === where.peerId) ?? null,
    findMany: async ({ where }: any) =>
      participants.filter((p) => {
        if (p.thesisId !== where.thesisId) return false
        if (where.lastSeenAt?.gte && !(p.lastSeenAt >= where.lastSeenAt.gte)) return false
        if (where.peerId?.not && p.peerId === where.peerId.not) return false
        return true
      }),
    upsert: async ({ where, update, create }: any) => {
      const existing = participants.find((p) => p.peerId === where.peerId)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const row = { id: `part-${participants.length + 1}`, joinedAt: new Date(), lastSeenAt: new Date(), ...create }
      participants.push(row)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const p of participants) {
        if (p.peerId !== where.peerId || p.thesisId !== where.thesisId) continue
        if (where.userId !== undefined && p.userId !== where.userId) continue
        if (where.guestInviteId !== undefined && p.guestInviteId !== where.guestInviteId) continue
        Object.assign(p, data)
        count++
      }
      return { count }
    },
    deleteMany: async ({ where }: any) => {
      const before = participants.length
      participants = participants.filter((p) => {
        if (where.guestInviteId !== undefined) return p.guestInviteId !== where.guestInviteId
        if (where.peerId !== undefined) {
          if (p.peerId !== where.peerId || p.thesisId !== where.thesisId) return true
          if (where.userId !== undefined && p.userId !== where.userId) return true
          if (where.guestInviteId !== undefined && p.guestInviteId !== where.guestInviteId) return true
          return false
        }
        if (where.thesisId !== undefined && where.lastSeenAt?.lt) return !(p.thesisId === where.thesisId && p.lastSeenAt < where.lastSeenAt.lt)
        return true
      })
      return { count: before - participants.length }
    },
  },
  defenseSignal: {
    findMany: async ({ where, take }: any) =>
      signals
        .filter((s) => s.thesisId === where.thesisId && s.consumed === where.consumed && s.toPeer === where.toPeer && s.fromPeer !== where.fromPeer.not)
        .slice(0, take ?? 60),
    create: async ({ data }: any) => {
      const row = { id: `sig-${++signalSeq}`, consumed: false, createdAt: new Date(), ...data }
      signals.push(row)
      return row
    },
    createMany: async ({ data }: any) => {
      for (const d of data) signals.push({ id: `sig-${++signalSeq}`, consumed: false, createdAt: new Date(), ...d })
      return { count: data.length }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const s of signals) if (where.id.in.includes(s.id)) { Object.assign(s, data); count++ }
      return { count }
    },
  },
  defenseMessage: { findMany: async () => [] },
  defenseGuestInvite: {
    findUnique: async ({ where }: any) => {
      if (where.tokenHash) return invites.find((i) => i.tokenHash === where.tokenHash) ?? null
      if (where.id) return invites.find((i) => i.id === where.id) ?? null
      return null
    },
    findMany: async ({ where }: any) => invites.filter((i) => i.thesisId === where.thesisId),
    create: async ({ data }: any) => {
      const row = { id: `inv-${++inviteSeq}`, createdAt: new Date(), revokedAt: null, lastJoinedAt: null, ...data }
      invites.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = invites.find((i) => i.id === where.id)
      if (row) Object.assign(row, data)
      return row
    },
  },
  setting: { findMany: async () => settings },
}

mock.module('@/lib/db', () => ({ db: dbMock }))
mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => currentUser,
  requireUser: async () => {
    if (!currentUser) throw new Error('UNAUTHORIZED')
    return currentUser
  },
  requireAdmin: async () => {
    if (!currentUser || currentUser.role !== 'ADMIN') throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {} }))

const room = await import('@/app/api/defense/room/route')
const invitesRoute = await import('@/app/api/admin/defense-invites/route')
const guestRoute = await import('@/app/api/defense/guest/[token]/route')
const configRoute = await import('@/app/api/webrtc/config/route')
const invitesLib = await import('@/lib/defense-invites')
const secretCrypto = await import('@/lib/secret-crypto')

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'المدير' }
const OWNER = { id: 'student-1', role: 'STUDENT', name: 'الطالب' }
const STRANGER_STUDENT = { id: 'student-9', role: 'STUDENT', name: 'غريب' }
const ASSIGNED_SUP = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف المسند' }
const OTHER_SUP = { id: 'sup-2', role: 'SUPERVISOR', name: 'مشرف آخر' }
const STAFF = { id: 'staff-1', role: 'STAFF', name: 'موظف' }

function postRoom(body: any) {
  return room.POST(new NextRequest('http://x/api/defense/room', { method: 'POST', body: JSON.stringify(body) }))
}
function getRoom(qs: string) {
  return room.GET(new NextRequest(`http://x/api/defense/room?${qs}`))
}
async function seedInvite(name = 'د. مناقش خارجي', opts: { expired?: boolean; revoked?: boolean; thesisId?: string } = {}) {
  const { invite, token } = await invitesLib.createDefenseGuestInvite(dbMock, {
    thesisId: opts.thesisId ?? 't1',
    name,
    role: 'COMMITTEE',
    expiresAt: opts.expired ? new Date(Date.now() - 3600000) : new Date(Date.now() + 86400000),
    createdById: 'admin-1',
  })
  if (opts.revoked) invite.revokedAt = new Date()
  return { invite, token }
}

beforeEach(reset)

describe('بوابة دخول القاعة لمستخدمي المنصة', () => {
  test('مشرف غير مسند: ممنوع من حالة القاعة ومن الانضمام', async () => {
    currentUser = OTHER_SUP
    expect((await getRoom('thesisId=t1')).status).toBe(403)
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-x', action: 'join', name: 'مشرف آخر' })).status).toBe(403)
    expect(participants.length).toBe(0)
  })

  test('المشرف المسند ينضم وتُسجل مشاركته بحسابه', async () => {
    currentUser = ASSIGNED_SUP
    const res = await postRoom({ thesisId: 't1', peerId: 'peer-sup', action: 'join', name: 'المشرف المسند', role: 'COMMITTEE', tz: 'Asia/Gaza' })
    expect(res.status).toBe(200)
    expect(participants.length).toBe(1)
    expect(participants[0].userId).toBe('sup-1')
    expect(participants[0].guestInviteId).toBeNull()
  })

  test('الأدمن يدخل أي قاعة، والطالب صاحب البحث فقط، والموظف لا يدخل', async () => {
    currentUser = ADMIN
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-admin', action: 'join' })).status).toBe(200)
    currentUser = OWNER
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-owner', action: 'join' })).status).toBe(200)
    expect(participants.find((p) => p.peerId === 'peer-owner')?.role).toBe('STUDENT')
    currentUser = STRANGER_STUDENT
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-stranger', action: 'join' })).status).toBe(403)
    currentUser = STAFF
    expect((await getRoom('thesisId=t1')).status).toBe(403)
  })

  test('بدون جلسة وبدون اعتماد ضيف: 401', async () => {
    currentUser = null
    expect((await getRoom('thesisId=t1')).status).toBe(401)
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-none', action: 'heartbeat' })).status).toBe(401)
  })
})

describe('دخول الضيوف بروابط الدعوة', () => {
  test('ضيف بدعوة صالحة ينضم بهوية الدعوة ودورها، ويصدر له سر جلسة', async () => {
    const { invite, token } = await seedInvite()
    currentUser = null
    const res = await postRoom({ thesisId: 't1', peerId: 'peer-guest', action: 'join', inviteToken: token, tz: 'Europe/Berlin' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(typeof json.guestSecret).toBe('string')
    expect(json.guestSecret.length).toBeGreaterThan(20)
    const p = participants.find((x) => x.peerId === 'peer-guest')
    expect(p.userId).toBeNull()
    expect(p.guestInviteId).toBe(invite.id)
    expect(p.name).toBe('د. مناقش خارجي')
    expect(p.role).toBe('COMMITTEE')
    // سر الجلسة مخزن هاشاً فقط
    expect(p.guestSecretHash).not.toBe(json.guestSecret)
    expect(invite.lastJoinedAt).toBeTruthy()
  })

  test('دعوة منتهية أو ملغاة أو لأطروحة أخرى: ممنوع', async () => {
    currentUser = null
    const expired = await seedInvite('منتهي', { expired: true })
    expect((await postRoom({ thesisId: 't1', peerId: 'p1', action: 'join', inviteToken: expired.token })).status).toBe(403)
    const revoked = await seedInvite('ملغي', { revoked: true })
    expect((await postRoom({ thesisId: 't1', peerId: 'p2', action: 'join', inviteToken: revoked.token })).status).toBe(403)
    const otherThesis = await seedInvite('لغيرها', { thesisId: 't-other' })
    expect((await postRoom({ thesisId: 't1', peerId: 'p3', action: 'join', inviteToken: otherThesis.token })).status).toBe(403)
    expect(participants.length).toBe(0)
  })

  test('نبض وإشارات وحالة القاعة للضيف بسر الجلسة فقط — وسر خاطئ يُرفض', async () => {
    const { token } = await seedInvite()
    currentUser = null
    const join = await postRoom({ thesisId: 't1', peerId: 'peer-guest', action: 'join', inviteToken: token })
    const { guestSecret } = await join.json()
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-guest', action: 'heartbeat', guestSecret })).status).toBe(200)
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-guest', action: 'heartbeat', guestSecret: 'wrong-secret' })).status).toBe(403)
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-guest', action: 'signal', type: 'ICE', payload: { c: 1 }, guestSecret })).status).toBe(200)
    const state = await getRoom(`thesisId=t1&peerId=peer-guest&guestSecret=${encodeURIComponent(guestSecret)}`)
    expect(state.status).toBe(200)
    const stateJson = await state.json()
    expect(stateJson.participants.map((p: any) => p.peerId)).toContain('peer-guest')
    expect((await getRoom('thesisId=t1&peerId=peer-guest')).status).toBe(401)
  })

  test('ضيف لا يستطيع ركوب معرّف اتصال مستخدم آخر', async () => {
    currentUser = OWNER
    await postRoom({ thesisId: 't1', peerId: 'peer-owner', action: 'join' })
    const { token } = await seedInvite()
    currentUser = null
    const res = await postRoom({ thesisId: 't1', peerId: 'peer-owner', action: 'join', inviteToken: token })
    expect(res.status).toBe(409)
  })
})

describe('إدارة الدعوات (أدمن)', () => {
  test('الإنشاء يعيد الرابط مرة واحدة ويخزن الهاش فقط، والقائمة لا تسرب السر', async () => {
    currentUser = ADMIN
    const res = await invitesRoute.POST(
      new NextRequest('http://x/api/admin/defense-invites', { method: 'POST', body: JSON.stringify({ thesisId: 't1', name: 'د. سارة', role: 'AGENT' }) }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.token.length).toBeGreaterThan(20)
    expect(json.url).toContain(`/defense/guest/${json.token}`)
    expect(invites.length).toBe(1)
    expect(invites[0].tokenHash).not.toBe(json.token)
    expect(invites[0].role).toBe('AGENT')
    const list = await invitesRoute.GET(new NextRequest('http://x/api/admin/defense-invites?thesisId=t1'))
    const listText = JSON.stringify(await list.json())
    expect(listText).not.toContain(json.token)
    expect(listText).not.toContain(invites[0].tokenHash)
  })

  test('غير الأدمن لا يدير الدعوات', async () => {
    currentUser = ASSIGNED_SUP
    const res = await invitesRoute.POST(
      new NextRequest('http://x/api/admin/defense-invites', { method: 'POST', body: JSON.stringify({ thesisId: 't1', name: 'x' }) }),
    )
    expect(res.status).toBe(403)
  })

  test('الإلغاء يمنع الدخول ويطرد الجلسة الجارية', async () => {
    currentUser = ADMIN
    const created = await (
      await invitesRoute.POST(new NextRequest('http://x/api/admin/defense-invites', { method: 'POST', body: JSON.stringify({ thesisId: 't1', name: 'د. عمر' }) }))
    ).json()
    currentUser = null
    const join = await postRoom({ thesisId: 't1', peerId: 'peer-g', action: 'join', inviteToken: created.token })
    expect(join.status).toBe(200)
    expect(participants.length).toBe(1)
    currentUser = ADMIN
    const del = await invitesRoute.DELETE(new NextRequest('http://x/api/admin/defense-invites', { method: 'DELETE', body: JSON.stringify({ id: created.invite.id }) }))
    expect(del.status).toBe(200)
    expect(participants.length).toBe(0)
    currentUser = null
    expect((await postRoom({ thesisId: 't1', peerId: 'peer-g2', action: 'join', inviteToken: created.token })).status).toBe(403)
  })
})

describe('صفحة تحقق الضيف وبيانات TURN', () => {
  test('التحقق العلني: دعوة صالحة تكشف الملخص، وملغاة لا تكشف شيئاً', async () => {
    const { token } = await seedInvite()
    const ok = await guestRoute.GET(new NextRequest('http://x'), { params: Promise.resolve({ token }) })
    expect(ok.status).toBe(200)
    const okJson = await ok.json()
    expect(okJson.status).toBe('VALID')
    expect(okJson.thesis.title).toBe('بحث التخرج الأول')
    expect(okJson.inviteeName).toBe('د. مناقش خارجي')
    const revoked = await seedInvite('ملغي', { revoked: true })
    const bad = await guestRoute.GET(new NextRequest('http://x'), { params: Promise.resolve({ token: revoked.token }) })
    expect(bad.status).toBe(410)
    const badJson = await bad.json()
    expect(badJson.status).toBe('REVOKED')
    expect(badJson.thesis).toBeUndefined()
  })

  test('TURN: مشرف غير مسند لا يحصل عليه، والمسند يحصل، وسر اللوحة المشفر يُفك قبل الإصدار', async () => {
    settings = [
      { key: 'TURN_URL', value: 'turn:turn.example.com:3478' },
      { key: 'TURN_USERNAME', value: 'aact' },
      { key: 'TURN_CREDENTIAL', value: secretCrypto.encryptSecret('plain-turn-pass') },
      { key: 'STUN_URLS', value: 'stun:stun.l.google.com:19302' },
    ]
    currentUser = OTHER_SUP
    const denied = await configRoute.GET(new NextRequest('http://x/api/webrtc/config?thesisId=t1'))
    expect((await denied.json()).hasTurn).toBe(false)
    currentUser = ASSIGNED_SUP
    const allowed = await configRoute.GET(new NextRequest('http://x/api/webrtc/config?thesisId=t1'))
    const allowedJson = await allowed.json()
    expect(allowedJson.hasTurn).toBe(true)
    const turnServer = allowedJson.iceServers.find((s: any) => s.username === 'aact')
    expect(turnServer.credential).toBe('plain-turn-pass')
  })

  test('TURN للضيف: رمز دعوة صالح يمنح بيانات الاتصال، ورمز ملغي لا', async () => {
    settings = [
      { key: 'TURN_URL', value: 'turn:turn.example.com:3478' },
      { key: 'TURN_USERNAME', value: 'aact' },
      { key: 'TURN_CREDENTIAL', value: 'plain' },
    ]
    const { token } = await seedInvite()
    currentUser = null
    const ok = await configRoute.GET(new NextRequest(`http://x/api/webrtc/config?thesisId=t1&inviteToken=${encodeURIComponent(token)}`))
    expect((await ok.json()).hasTurn).toBe(true)
    const revoked = await seedInvite('ملغي', { revoked: true })
    const bad = await configRoute.GET(new NextRequest(`http://x/api/webrtc/config?thesisId=t1&inviteToken=${encodeURIComponent(revoked.token)}`))
    expect(bad.status).toBe(403)
  })
})
