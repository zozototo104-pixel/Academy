import { createHmac } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { getSettings } from '@/lib/settings'
import { unsealSettingSecret } from '@/lib/secret-crypto'
import {
  findMeetingInviteByToken,
  isMeetingJoinOpen,
  meetingInviteProblem,
} from '@/lib/admin-meetings'

// ===== غرفة فيديو الاجتماع الداخلية (WebRTC mesh) =====
// مرآة meeting-scoped لمسار قاعة المناقشة (/api/defense/room):
// إشارات OFFER / ANSWER / ICE / BYE عبر قاعدة البيانات، والبث يُحوّل
// عند الإرسال إلى نسخ موجهة لكل مشارك حاضر. الحضور يُتتبَّع بصفوف
// إشارة من نوع PRESENCE تُجدَّد مع كل نبضة (لا يوجد جدول مشاركين
// للاجتماعات) — نفس دلالة lastSeenAt في قاعة المناقشة.
// التوثيق: جلسة مستخدم يكون ADMIN أو صاحب الدعوة المستلَمة بهذا
// الرابط (claimedByUserId)؛ الدعوة الملغاة/المنتهية مرفوضة.
// نافذة الدخول (15 دقيقة قبل البدء حتى النهاية) مفروضة خادمياً:
// خارجها كل عمليات الغرفة 403 JOIN_WINDOW_CLOSED عدا المغادرة.

const ONLINE_WINDOW_MS = 20_000 // المشارك يعتبر حاضراً ضمن آخر 20 ثانية
const MAX_PEER_ID_LENGTH = 160
const MAX_SIGNAL_PAYLOAD_CHARS = 32_000
const SIGNAL_TYPES = new Set(['OFFER', 'ANSWER', 'ICE', 'BYE'])
const PRESENCE_TYPE = 'PRESENCE'

const DEFAULT_STUNS = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
const DEFAULT_TURN_TTL_SECONDS = 15 * 60

function normalizePeerId(peerId?: string | null): string {
  return String(peerId || '').trim()
}

function assertValidPeerId(peerId: string) {
  if (!peerId || peerId.length > MAX_PEER_ID_LENGTH) throw new Error('BAD_PEER')
}

function serializeSignalPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload || {})
  if (serialized.length > MAX_SIGNAL_PAYLOAD_CHARS) throw new Error('PAYLOAD_TOO_LARGE')
  return serialized
}

// ---------- خوادم ICE/TURN: نفس قراءة إعدادات /api/webrtc/config ----------
// (خريطة الإعدادات + احتياطي متغيرات البيئة + فك ختم الأسرار + بيانات
// TURN مؤقتة بتوقيع HMAC عند توفر REST secret). التفويض هنا هو توثيق
// غرفة الاجتماع نفسه بدل بوابة قاعة المناقشة.
function settingEnv(map: Record<string, string>, key: string): string {
  try {
    return (map[key] || process.env[key] || '').trim()
  } catch {
    return (map[key] || '').trim()
  }
}

function parseStunUrls(value: string) {
  return (value || DEFAULT_STUNS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function ttlSeconds(value: string) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TURN_TTL_SECONDS
  return Math.max(60, Math.min(3600, Math.floor(parsed)))
}

async function buildIceServers(userId: string, meetingId: string) {
  const map = await getSettings()
  const turnUrl = settingEnv(map, 'TURN_URL')
  const turnTcp = settingEnv(map, 'TURN_TCP_URL')
  const turnUser = settingEnv(map, 'TURN_USERNAME')
  const turnPass = unsealSettingSecret(settingEnv(map, 'TURN_CREDENTIAL'))
  const turnRestSecret =
    unsealSettingSecret(settingEnv(map, 'TURN_REST_SECRET')) ||
    unsealSettingSecret(settingEnv(map, 'TURN_SHARED_SECRET'))
  const ttl = ttlSeconds(settingEnv(map, 'TURN_TTL_SECONDS'))
  const stuns = parseStunUrls(settingEnv(map, 'STUN_URLS'))
  const iceServers: RTCIceServer[] = [{ urls: stuns }]

  if (turnUrl) {
    const urls = turnTcp ? [turnUrl, turnTcp] : [turnUrl]
    if (turnRestSecret) {
      const expiresAt = Math.floor(Date.now() / 1000) + ttl
      const username = `${expiresAt}:aact:${userId}:meeting:${meetingId}`
      const credential = createHmac('sha1', turnRestSecret).update(username).digest('base64')
      iceServers.push({ urls, username, credential })
      return { iceServers, hasTurn: true }
    }
    if (turnUser && turnPass) {
      iceServers.push({ urls, username: turnUser, credential: turnPass })
      return { iceServers, hasTurn: true }
    }
  }
  return { iceServers, hasTurn: false }
}

// ---------- التوثيق ونافذة الدخول ----------

type RoomActor = {
  user: { id: string; role: string; name: string | null }
  invite: any
  meeting: any
}

// حلّ مزدوج لمقطع [token]: قد يكون رمز الدعوة الخام نفسه (من رابط
// الدعوة) أو معرّف دعوة مستلَمة (من قائمة اجتماعات حساب المشارك،
// حيث لم يعد الرمز الخام بحوزته). الترتيب: هاش الرمز أولاً، ثم
// المعرّف — وبعده نفس التوثيق في الحالين.
async function resolveRoomActor(segment: string): Promise<RoomActor> {
  const user = await getCurrentUser()
  if (!user) throw new Error('UNAUTHORIZED')
  let invite = await findMeetingInviteByToken(db as any, segment)
  if (!invite) {
    invite = await db.adminMeetingInvite
      .findUnique({ where: { id: String(segment || '').trim() }, include: { meeting: true } })
      .catch(() => null)
    // مسار المعرّف لا يعمل إلا لصاحب الدعوة المستلَمة أو للإدارة
    if (invite && user.role !== 'ADMIN' && invite.claimedByUserId !== user.id) {
      throw new Error('FORBIDDEN')
    }
  }
  if (!invite || meetingInviteProblem(invite)) throw new Error('INVITE_INVALID')
  if (user.role !== 'ADMIN' && invite.claimedByUserId !== user.id) throw new Error('FORBIDDEN')
  const meeting = invite.meeting
  if (!meeting) throw new Error('INVITE_INVALID')
  if (meeting.provider !== 'PLATFORM') throw new Error('NOT_PLATFORM_ROOM')
  return { user: { id: user.id, role: user.role, name: user.name ?? null }, invite, meeting }
}

function assertJoinOpen(meeting: any) {
  if (!isMeetingJoinOpen(meeting)) throw new Error('JOIN_WINDOW_CLOSED')
}

// تسجيل الحضور عند أول دخول فعلي للغرفة (انضمام أو أول استطلاع) —
// يُستدعى فقط بعد التحقق من نافذة الدخول.
async function recordAttendance(actor: RoomActor) {
  await db.adminMeetingAttendance
    .upsert({
      where: { meetingId_userId: { meetingId: actor.meeting.id, userId: actor.user.id } },
      create: {
        meetingId: actor.meeting.id,
        userId: actor.user.id,
        inviteId: actor.invite.id,
        status: 'JOINED',
      },
      update: {},
    })
    .catch(() => {})
}

// ---------- الحضور عبر صفوف PRESENCE ----------

type PresenceInfo = { name: string; userId: string }

function parsePresence(payload: string): PresenceInfo {
  try {
    const p = JSON.parse(payload || '{}')
    return { name: String(p.name || '').slice(0, 80), userId: String(p.userId || '') }
  } catch {
    return { name: '', userId: '' }
  }
}

async function latestPresence(meetingId: string, peerId: string, client: Prisma.TransactionClient | typeof db = db) {
  const row = await client.adminMeetingSignal.findFirst({
    where: {
      meetingId,
      type: PRESENCE_TYPE,
      fromPeer: peerId,
      createdAt: { gte: new Date(Date.now() - ONLINE_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  })
  return row ? { row, info: parsePresence(row.payload) } : null
}

async function touchPresence(meetingId: string, peerId: string, info: PresenceInfo, client: Prisma.TransactionClient | typeof db = db) {
  await client.adminMeetingSignal.deleteMany({
    where: { meetingId, type: PRESENCE_TYPE, fromPeer: peerId },
  })
  await client.adminMeetingSignal.create({
    data: {
      meetingId,
      fromPeer: peerId,
      toPeer: null,
      type: PRESENCE_TYPE,
      payload: JSON.stringify(info),
      consumed: true, // صفوف الحضور لا تُسلَّم كإشارات أبداً
    },
  })
}

// Serialize join and heartbeat for the same peer identity. Without a
// serializable read/check/write cycle, two users can both see no presence
// and overwrite each other's claim between deleteMany and create.
async function refreshOwnedPresence(
  meetingId: string,
  peerId: string,
  userId: string,
  name: string,
  action: 'join' | 'heartbeat',
) {
  const maxAttempts = 3
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await db.$transaction(async (tx) => {
        const existing = await latestPresence(meetingId, peerId, tx)
        if (action === 'heartbeat' && !existing) throw new Error('FORBIDDEN_PEER')
        if (existing && existing.info.userId !== userId) {
          throw new Error(action === 'join' ? 'PEER_IN_USE' : 'FORBIDDEN_PEER')
        }
        await touchPresence(meetingId, peerId, {
          name: action === 'heartbeat' ? (existing?.info.name || name) : name,
          userId,
        }, tx)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return
    } catch (e: unknown) {
      // PostgreSQL rolls back one of two conflicting serializable writes.
      // Retry against the current owner; never turn a collision into access.
      if ((e as { code?: string })?.code !== 'P2034') throw e
      if (attempt === maxAttempts - 1) throw new Error('PEER_CONFLICT')
    }
  }
}

async function clearPresence(meetingId: string, peerId: string) {
  await db.adminMeetingSignal
    .deleteMany({ where: { meetingId, type: PRESENCE_TYPE, fromPeer: peerId } })
    .catch(() => {})
}

async function onlinePeers(meetingId: string): Promise<{ peerId: string; name: string }[]> {
  const rows = await db.adminMeetingSignal.findMany({
    where: {
      meetingId,
      type: PRESENCE_TYPE,
      createdAt: { gte: new Date(Date.now() - ONLINE_WINDOW_MS) },
    },
    orderBy: { createdAt: 'asc' },
  })
  const byPeer = new Map<string, { peerId: string; name: string }>()
  for (const r of rows) {
    byPeer.set(r.fromPeer, { peerId: r.fromPeer, name: parsePresence(r.payload).name })
  }
  return [...byPeer.values()]
}

// مالك الاتصال: صف الحضور الطازج لهذا peerId يجب أن يخص هذا المستخدم.
async function requireOwnedPeer(meetingId: string, peerId: string, userId: string) {
  assertValidPeerId(peerId)
  const presence = await latestPresence(meetingId, peerId)
  if (!presence || presence.info.userId !== userId) throw new Error('FORBIDDEN_PEER')
}

async function createDirectedOrFanoutSignal(params: {
  meetingId: string
  fromPeer: string
  toPeer?: string | null
  type: string
  payload: unknown
}) {
  const { meetingId, fromPeer, toPeer, type } = params
  if (!SIGNAL_TYPES.has(type)) throw new Error('BAD_SIGNAL_TYPE')
  const payload = serializeSignalPayload(params.payload)

  if (toPeer) {
    await db.adminMeetingSignal.create({
      data: { meetingId, fromPeer, toPeer, type, payload },
    })
    return 1
  }

  const recipients = (await onlinePeers(meetingId)).filter((p) => p.peerId !== fromPeer)
  if (recipients.length === 0) return 0
  await db.adminMeetingSignal.createMany({
    data: recipients.map((r) => ({ meetingId, fromPeer, toPeer: r.peerId, type, payload })),
  })
  return recipients.length
}

function errorResponse(e: any) {
  const code = String(e?.message || '')
  if (code === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول', code }, { status: 401 })
  if (code === 'INVITE_INVALID') return NextResponse.json({ error: 'رابط الدعوة غير صالح أو ملغى أو منتهٍ', code }, { status: 403 })
  if (code === 'FORBIDDEN') return NextResponse.json({ error: 'هذه الدعوة ليست مرتبطة بحسابك', code }, { status: 403 })
  if (code === 'FORBIDDEN_PEER') return NextResponse.json({ error: 'معرف الاتصال لا يخصك', code }, { status: 403 })
  if (code === 'JOIN_WINDOW_CLOSED') {
    return NextResponse.json(
      { error: 'الدخول إلى الغرفة يفتح قبل موعد الاجتماع بـ15 دقيقة ويغلق عند نهايته', code },
      { status: 403 },
    )
  }
  if (code === 'NOT_PLATFORM_ROOM') return NextResponse.json({ error: 'هذا الاجتماع ليس بغرفة المنصة الداخلية', code }, { status: 400 })
  if (code === 'BAD_PEER') return NextResponse.json({ error: 'معرف الاتصال غير صالح', code }, { status: 400 })
  if (code === 'BAD_SIGNAL_TYPE') return NextResponse.json({ error: 'نوع إشارة غير معروف', code }, { status: 400 })
  if (code === 'PAYLOAD_TOO_LARGE') return NextResponse.json({ error: 'حجم إشارة الاتصال أكبر من الحد المسموح', code }, { status: 413 })
  if (code === 'PEER_IN_USE') return NextResponse.json({ error: 'معرف الاتصال مستخدم في جلسة أخرى', code }, { status: 409 })
  console.error('meeting room error:', e)
  return NextResponse.json({ error: 'خطأ في غرفة الاجتماع' }, { status: 500 })
}

// GET /api/meetings/[token]/room?peerId= — الحاضرون + إشاراتي غير المستهلكة + خوادم ICE
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const actor = await resolveRoomActor(token)
    // Every room GET, including discovery without peerId, must respect the join window.
    // Otherwise peers and ICE/TURN credentials are exposed before entry opens.
    assertJoinOpen(actor.meeting)
    const peerId = normalizePeerId(req.nextUrl.searchParams.get('peerId'))

    if (peerId) {
      // Polling is allowed only after a successful join created a fresh,
      // owned presence. A missing presence is NOT permission to consume
      // signals addressed to an arbitrary peerId.
      await requireOwnedPeer(actor.meeting.id, peerId, actor.user.id)
      await recordAttendance(actor)
    }

    let signals: any[] = []
    if (peerId) {
      const rows = await db.adminMeetingSignal.findMany({
        where: {
          meetingId: actor.meeting.id,
          consumed: false,
          fromPeer: { not: peerId },
          toPeer: peerId,
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      })
      signals = rows
      if (rows.length > 0) {
        await db.adminMeetingSignal.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, toPeer: peerId },
          data: { consumed: true },
        })
      }
    }

    const peers = (await onlinePeers(actor.meeting.id)).filter((p) => p.peerId !== peerId)
    const ice = await buildIceServers(actor.user.id, actor.meeting.id)

    return NextResponse.json({
      ok: true,
      peers: peers.map((p) => p.peerId),
      peersMeta: peers,
      signals: signals.map((s) => {
        let payload: any = {}
        try {
          payload = JSON.parse(s.payload || '{}')
        } catch { /* best-effort */ }
        return { id: s.id, from: s.fromPeer, to: s.toPeer, type: s.type, payload }
      }),
      iceServers: ice.iceServers,
      hasTurn: ice.hasTurn,
    })
  } catch (e: any) {
    return errorResponse(e)
  }
}

// POST /api/meetings/[token]/room — انضمام/نبض/مغادرة/إشارة
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const actor = await resolveRoomActor(token)
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    const peerId = normalizePeerId(body.peerId)
    const meetingId = actor.meeting.id

    if (action === 'join') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      assertValidPeerId(peerId)
      assertJoinOpen(actor.meeting)
      const name = String(body.name || actor.user.name || actor.invite.inviteeName || 'مشارك').slice(0, 80)
      await refreshOwnedPresence(meetingId, peerId, actor.user.id, name, 'join')
      await recordAttendance(actor)
      // تنظيف صفوف حضور قديمة انتهت نافذتها
      await db.adminMeetingSignal
        .deleteMany({
          where: { meetingId, type: PRESENCE_TYPE, createdAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        })
        .catch(() => {})
      const ice = await buildIceServers(actor.user.id, meetingId)
      return NextResponse.json({ ok: true, peerId, iceServers: ice.iceServers, hasTurn: ice.hasTurn })
    }

    if (action === 'heartbeat') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      assertJoinOpen(actor.meeting)
      await refreshOwnedPresence(
        meetingId,
        peerId,
        actor.user.id,
        String(actor.user.name || 'مشارك').slice(0, 80),
        'heartbeat',
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'leave') {
      // المغادرة مسموحة دائماً (حتى بعد إغلاق النافذة) لتنظيف الاتصالات
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      await requireOwnedPeer(meetingId, peerId, actor.user.id)
      await createDirectedOrFanoutSignal({ meetingId, fromPeer: peerId, type: 'BYE', payload: {} })
      await clearPresence(meetingId, peerId)
      return NextResponse.json({ ok: true })
    }

    if (action === 'signal') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      assertJoinOpen(actor.meeting)
      await requireOwnedPeer(meetingId, peerId, actor.user.id)
      const toPeer = normalizePeerId(body.toPeer || body.to)
      const delivered = await createDirectedOrFanoutSignal({
        meetingId,
        fromPeer: peerId,
        toPeer: toPeer || null,
        type: String(body.type || ''),
        payload: body.payload,
      })
      return NextResponse.json({ ok: true, delivered })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    return errorResponse(e)
  }
}
