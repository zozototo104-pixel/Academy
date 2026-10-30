import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  canEnterDefenseRoom,
  defenseGuestInviteProblem,
  findInviteByToken,
  issueGuestSecret,
  verifyGuestSecret,
} from '@/lib/defense-invites'

/**
 * 12.3 — قاعة الفيديو كونفرنس متعدد الأطراف داخل المنصة
 * بواجهة إشارات WebRTC (Signaling) عبر قاعدة البيانات:
 * - المشاركون: الطالب + مشرفه الخاص + أعضاء اللجنة + خبير الذكاء الاصطناعي (بلاط تحليلي)
 * - الحضور (قرار المالك 2026-10-30): من أهل المنصة يدخل الأدمن دائماً، والطالب قاعته
 *   فقط، والمشرف طلابه المسندين فقط. المناقشون الخارجيون (حتى بلا حساب) يدخلون
 *   بروابط دعوة شخصية منتهية وقابلة للإلغاء — انظر src/lib/defense-invites.ts.
 * - الإشارات: OFFER / ANSWER / ICE / BYE بين المتصفحات مباشرة (P2P mesh)
 * - عرض المنطقة الزمنية لكل مشارك لتراعي فروق التوقيت بين الدول
 */

const ONLINE_WINDOW_MS = 15000 // المشارك يعتبر متصلاً ضمن آخر 15 ثانية
const MAX_PEER_ID_LENGTH = 160
const MAX_SIGNAL_PAYLOAD_CHARS = 32_000
const SIGNAL_TYPES = new Set(['OFFER', 'ANSWER', 'ICE', 'BYE'])

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

type Actor =
  | { kind: 'user'; user: { id: string; role: string; name: string | null } }
  | { kind: 'guest'; invite: any }

async function requireOwnedParticipant(thesisId: string, peerId: string, actor: Actor) {
  assertValidPeerId(peerId)
  const participant = await db.defenseParticipant.findFirst({
    where: { thesisId, peerId },
    select: { id: true, peerId: true, userId: true, guestInviteId: true, guestSecretHash: true },
  })
  if (!participant) throw new Error('FORBIDDEN_PEER')
  if (actor.kind === 'user') {
    if (participant.userId !== actor.user.id) throw new Error('FORBIDDEN_PEER')
  } else {
    if (participant.guestInviteId !== actor.invite.id) throw new Error('FORBIDDEN_PEER')
  }
  return participant
}

function assertGuestSecret(participant: any, presented: string | null | undefined) {
  if (!verifyGuestSecret(participant?.guestSecretHash, presented)) throw new Error('FORBIDDEN_PEER')
}

async function createDirectedOrFanoutSignal(params: {
  thesisId: string
  fromPeer: string
  toPeer?: string | null
  type: string
  payload: unknown
}) {
  const { thesisId, fromPeer, toPeer, type } = params
  if (!SIGNAL_TYPES.has(type)) throw new Error('BAD_SIGNAL_TYPE')
  const payload = serializeSignalPayload(params.payload)

  if (toPeer) {
    const target = await db.defenseParticipant.findFirst({
      where: { thesisId, peerId: toPeer },
      select: { id: true },
    })
    if (!target) throw new Error('UNKNOWN_TARGET_PEER')
    await db.defenseSignal.create({
      data: { thesisId, fromPeer, toPeer, type, payload },
    })
    return 1
  }

  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS)
  const recipients = await db.defenseParticipant.findMany({
    where: { thesisId, peerId: { not: fromPeer }, lastSeenAt: { gte: cutoff } },
    select: { peerId: true },
  })
  if (recipients.length === 0) return 0
  await db.defenseSignal.createMany({
    data: recipients.map((recipient) => ({ thesisId, fromPeer, toPeer: recipient.peerId, type, payload })),
  })
  return recipients.length
}

async function loadThesis(thesisId: string) {
  return db.thesisSubmission.findUnique({ where: { id: thesisId } })
}

// ممثل ضيف من دعوة: يتحقق من صلاحية الدعوة وتطابق الأطروحة
async function guestActorForThesis(token: string, thesisId: string): Promise<Actor> {
  const invite = await findInviteByToken(db as any, token)
  if (defenseGuestInviteProblem(invite) || invite.thesisId !== thesisId) throw new Error('GUEST_INVALID')
  return { kind: 'guest', invite }
}

// GET /api/defense/room?thesisId=&peerId= — حالة القاعة: المشاركون + الإشارات غير المستهلكة + المحادثة
export async function GET(req: NextRequest) {
  try {
    const thesisId = req.nextUrl.searchParams.get('thesisId')
    const peerId = normalizePeerId(req.nextUrl.searchParams.get('peerId'))
    const guestSecret = req.nextUrl.searchParams.get('guestSecret')
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })

    const user = await getCurrentUser()
    let actor: Actor
    let thesis: any
    if (user) {
      thesis = await loadThesis(thesisId)
      if (!thesis || !(await canEnterDefenseRoom(thesis, user))) {
        return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })
      }
      actor = { kind: 'user', user }
      if (peerId) {
        await requireOwnedParticipant(thesisId, peerId, actor)
      }
    } else {
      // ضيف: لا حالة قاعة بدون انضمام موثّق (معرّف اتصال + سر الجلسة)
      if (!peerId || !guestSecret) {
        return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
      }
      const participant = await db.defenseParticipant.findFirst({
        where: { thesisId, peerId },
        select: { id: true, guestInviteId: true, guestSecretHash: true },
      })
      if (!participant?.guestInviteId) throw new Error('FORBIDDEN_PEER')
      assertGuestSecret(participant, guestSecret)
      const invite = await db.defenseGuestInvite.findUnique({ where: { id: participant.guestInviteId } })
      if (defenseGuestInviteProblem(invite) || invite.thesisId !== thesisId) throw new Error('GUEST_INVALID')
      actor = { kind: 'guest', invite }
      thesis = await loadThesis(thesisId)
      if (!thesis) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })
    }

    const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS)
    const participants = await db.defenseParticipant.findMany({
      where: { thesisId, lastSeenAt: { gte: cutoff } },
      orderBy: { joinedAt: 'asc' },
    })

    // الإشارات الموجهة لهذا المشارك فقط. رسائل البث تُحوّل عند الإرسال إلى نسخ لكل مستلم.
    let signals: any[] = []
    if (peerId) {
      const rows = await db.defenseSignal.findMany({
        where: {
          thesisId,
          consumed: false,
          fromPeer: { not: peerId },
          toPeer: peerId,
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      })
      signals = rows
      if (rows.length > 0) {
        await db.defenseSignal.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, toPeer: peerId },
          data: { consumed: true },
        })
      }
    }

    const messages = await db.defenseMessage.findMany({
      where: { thesisId },
      orderBy: { createdAt: 'asc' },
      take: 60,
    })

    return NextResponse.json({
      participants: participants.map((p) => ({
        peerId: p.peerId,
        name: p.name,
        role: p.role,
        tz: p.tz,
        joinedAt: p.joinedAt,
      })),
      signals: signals.map((s) => ({ id: s.id, from: s.fromPeer, to: s.toPeer, type: s.type, payload: JSON.parse(s.payload || '{}') })),
      messages,
      defenseStatus: thesis.defenseStatus,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    if (e?.message === 'GUEST_INVALID') return NextResponse.json({ error: 'رابط الدعوة غير صالح أو منتهٍ أو ملغي' }, { status: 403 })
    if (e?.message === 'FORBIDDEN_PEER') return NextResponse.json({ error: 'معرف الاتصال لا يخصك' }, { status: 403 })
    if (e?.message === 'BAD_PEER') return NextResponse.json({ error: 'معرف الاتصال غير صالح' }, { status: 400 })
    console.error('defense room GET error:', e)
    return NextResponse.json({ error: 'خطأ في قاعة المناقشة' }, { status: 500 })
  }
}

// POST /api/defense/room — انضمام/نبض/مغادرة/إشارة
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    const body = await req.json()
    const { thesisId, peerId, action } = body as {
      thesisId: string
      peerId?: string
      action: 'join' | 'heartbeat' | 'leave' | 'signal'
    }
    const currentPeerId = normalizePeerId(peerId)
    if (!thesisId || !action) return NextResponse.json({ error: 'بيانات ناقصة' }, { status: 400 })

    // انضمام ضيف برابط دعوة (بلا حساب): الهوية والاسم والدور من الدعوة نفسها
    if (!user && action === 'join') {
      const actor = await guestActorForThesis(String(body.inviteToken || ''), thesisId)
      if (actor.kind !== 'guest') throw new Error('GUEST_INVALID')
      const invite = actor.invite
      if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      assertValidPeerId(currentPeerId)
      const existingPeer = await db.defenseParticipant.findUnique({
        where: { peerId: currentPeerId },
        select: { thesisId: true, userId: true, guestInviteId: true },
      })
      if (existingPeer && (existingPeer.thesisId !== thesisId || existingPeer.guestInviteId !== invite.id)) {
        return NextResponse.json({ error: 'معرف الاتصال مستخدم في جلسة أخرى' }, { status: 409 })
      }
      const { secret, secretHash } = issueGuestSecret()
      const tz = String(body.tz || '').slice(0, 60) || null
      const p = await db.defenseParticipant.upsert({
        where: { peerId: currentPeerId },
        update: { name: invite.name, role: invite.role, tz, userId: null, guestInviteId: invite.id, guestSecretHash: secretHash, lastSeenAt: new Date() },
        create: { thesisId, peerId: currentPeerId, userId: null, guestInviteId: invite.id, guestSecretHash: secretHash, name: invite.name, role: invite.role, tz },
      })
      await db.defenseGuestInvite.update({ where: { id: invite.id }, data: { lastJoinedAt: new Date() } }).catch(() => {})
      await db.defenseParticipant.deleteMany({
        where: { thesisId, lastSeenAt: { lt: new Date(Date.now() - 5 * 60000) } },
      })
      return NextResponse.json({ ok: true, peerId: p.peerId, guestSecret: secret, name: invite.name, role: invite.role })
    }

    if (!user) {
      // باقي إجراءات الضيوف تمر عبر توثيق المشارك أدناه بعد تحميل الأطروحة من الدعوة
      if (!currentPeerId) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
      const participant = await db.defenseParticipant.findFirst({
        where: { thesisId, peerId: currentPeerId },
        select: { id: true, guestInviteId: true, guestSecretHash: true },
      })
      if (!participant?.guestInviteId) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
      assertGuestSecret(participant, body.guestSecret)
      const invite = await db.defenseGuestInvite.findUnique({ where: { id: participant.guestInviteId } })
      if (defenseGuestInviteProblem(invite) || invite.thesisId !== thesisId) throw new Error('GUEST_INVALID')
      const actor: Actor = { kind: 'guest', invite }
      return await handleAction(body, actor, thesisId, currentPeerId, null)
    }

    const thesis = await loadThesis(thesisId)
    if (!thesis || !(await canEnterDefenseRoom(thesis, user))) {
      return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })
    }
    const actor: Actor = { kind: 'user', user }
    return await handleAction(body, actor, thesisId, currentPeerId, user)
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    if (e?.message === 'GUEST_INVALID') return NextResponse.json({ error: 'رابط الدعوة غير صالح أو منتهٍ أو ملغي' }, { status: 403 })
    if (e?.message === 'FORBIDDEN_PEER') return NextResponse.json({ error: 'معرف الاتصال لا يخصك' }, { status: 403 })
    if (e?.message === 'BAD_PEER') return NextResponse.json({ error: 'معرف الاتصال غير صالح' }, { status: 400 })
    if (e?.message === 'BAD_SIGNAL_TYPE') return NextResponse.json({ error: 'نوع إشارة غير معروف' }, { status: 400 })
    if (e?.message === 'UNKNOWN_TARGET_PEER') return NextResponse.json({ error: 'المشارك المستهدف غير موجود في القاعة' }, { status: 404 })
    if (e?.message === 'PAYLOAD_TOO_LARGE') return NextResponse.json({ error: 'حجم إشارة الاتصال أكبر من الحد المسموح' }, { status: 413 })
    console.error('defense room POST error:', e)
    return NextResponse.json({ error: 'خطأ في قاعة المناقشة' }, { status: 500 })
  }
}

async function handleAction(body: any, actor: Actor, thesisId: string, currentPeerId: string, user: { id: string; role: string; name: string | null } | null) {
  const action = body.action as string

  if (action === 'join') {
    // انضمام الضيوف يُعالج في POST قبل الوصول هنا (يحتاج رمز الدعوة)
    if (!user) throw new Error('GUEST_INVALID')
    if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
    assertValidPeerId(currentPeerId)
    const existingPeer = await db.defenseParticipant.findUnique({
      where: { peerId: currentPeerId },
      select: { thesisId: true, userId: true },
    })
    if (existingPeer && (existingPeer.thesisId !== thesisId || existingPeer.userId !== user.id)) {
      return NextResponse.json({ error: 'معرف الاتصال مستخدم في جلسة أخرى' }, { status: 409 })
    }
    // الدور يُحسب خادمياً من حساب المستخدم — لا يُقبل دور من العميل (منع انتحال صفة اللجنة)
    const name = String(user.role === 'STUDENT' ? user.name : body.name || user.name)
      .slice(0, 80)
    const role = user.role === 'STUDENT' ? 'STUDENT' : user.role === 'SUPERVISOR' && ['COMMITTEE', 'AGENT'].includes(body.role) ? body.role : 'COMMITTEE'
    const tz = String(body.tz || '').slice(0, 60) || null
    const p = await db.defenseParticipant.upsert({
      where: { peerId: currentPeerId },
      update: { name, role, tz, userId: user.id, guestInviteId: null, guestSecretHash: null, lastSeenAt: new Date() },
      create: { thesisId, peerId: currentPeerId, userId: user.id, guestInviteId: null, guestSecretHash: null, name, role, tz },
    })
    // تنظيف المشاركين القدماء غير النشطين لهذا البحث
    await db.defenseParticipant.deleteMany({
      where: { thesisId, lastSeenAt: { lt: new Date(Date.now() - 5 * 60000) } },
    })
    return NextResponse.json({ ok: true, peerId: p.peerId })
  }

  if (action === 'heartbeat') {
    if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
    const participant = await requireOwnedParticipant(thesisId, currentPeerId, actor)
    if (actor.kind === 'guest') assertGuestSecret(participant, body.guestSecret)
    await db.defenseParticipant.updateMany({
      where: { peerId: currentPeerId, thesisId, ...(actor.kind === 'user' ? { userId: actor.user.id } : { guestInviteId: actor.invite.id }) },
      data: { lastSeenAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  }

  if (action === 'leave') {
    if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
    const participant = await requireOwnedParticipant(thesisId, currentPeerId, actor)
    if (actor.kind === 'guest') assertGuestSecret(participant, body.guestSecret)
    // بث مغادرة للجميع كنسخ موجهة حتى لا يستهلكها أول مشارك فقط
    await createDirectedOrFanoutSignal({ thesisId, fromPeer: currentPeerId, type: 'BYE', payload: {} })
    await db.defenseParticipant.deleteMany({
      where: { peerId: currentPeerId, thesisId, ...(actor.kind === 'user' ? { userId: actor.user.id } : { guestInviteId: actor.invite.id }) },
    })
    return NextResponse.json({ ok: true })
  }

  if (action === 'signal') {
    if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
    const participant = await requireOwnedParticipant(thesisId, currentPeerId, actor)
    if (actor.kind === 'guest') assertGuestSecret(participant, body.guestSecret)
    const { type, payload, to } = body as { type: string; payload: any; to?: string | null }
    const toPeer = normalizePeerId(to)
    const delivered = await createDirectedOrFanoutSignal({
      thesisId,
      fromPeer: currentPeerId,
      toPeer: toPeer || null,
      type,
      payload,
    })
    return NextResponse.json({ ok: true, delivered })
  }

  return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
}
