import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

/**
 * 12.3 — قاعة الفيديو كونفرنس متعدد الأطراف داخل المنصة
 * بواجهة إشارات WebRTC (Signaling) عبر قاعدة البيانات:
 * - المشاركون: الطالب + أعضاء اللجنة متصلين من دول/مواقع مختلفة + خبير الذكاء الاصطناعي (بلاط تحليلي)
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

async function requireOwnedParticipant(thesisId: string, peerId: string, userId: string) {
  assertValidPeerId(peerId)
  const participant = await db.defenseParticipant.findFirst({
    where: { thesisId, peerId },
    select: { id: true, peerId: true, userId: true },
  })
  if (!participant || participant.userId !== userId) throw new Error('FORBIDDEN_PEER')
  return participant
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

async function getThesisForUser(thesisId: string, userId: string, role: string) {
  const thesis = await db.thesisSubmission.findUnique({ where: { id: thesisId } })
  if (!thesis) return null
  // الطالب يصل لقاعة بحثه فقط — الإدارة والمشرفون يصلون لكل القاعات
  if (role === 'STUDENT' && thesis.userId !== userId) return null
  return thesis
}

// GET /api/defense/room?thesisId=&peerId= — حالة القاعة: المشاركون + الإشارات غير المستهلكة + المحادثة
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const thesisId = req.nextUrl.searchParams.get('thesisId')
    const peerId = normalizePeerId(req.nextUrl.searchParams.get('peerId'))
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })

    const thesis = await getThesisForUser(thesisId, user.id, user.role)
    if (!thesis) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })

    const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS)
    const participants = await db.defenseParticipant.findMany({
      where: { thesisId, lastSeenAt: { gte: cutoff } },
      orderBy: { joinedAt: 'asc' },
    })

    // الإشارات الموجهة لهذا المشارك فقط. رسائل البث تُحوّل عند الإرسال إلى نسخ لكل مستلم.
    let signals: any[] = []
    if (peerId) {
      await requireOwnedParticipant(thesisId, peerId, user.id)
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
    if (e?.message === 'FORBIDDEN_PEER') return NextResponse.json({ error: 'معرف الاتصال لا يخص حسابك' }, { status: 403 })
    if (e?.message === 'BAD_PEER') return NextResponse.json({ error: 'معرف الاتصال غير صالح' }, { status: 400 })
    console.error('defense room GET error:', e)
    return NextResponse.json({ error: 'خطأ في قاعة المناقشة' }, { status: 500 })
  }
}

// POST /api/defense/room — انضمام/نبض/مغادرة/إشارة
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const { thesisId, peerId, action } = body as {
      thesisId: string
      peerId?: string
      action: 'join' | 'heartbeat' | 'leave' | 'signal'
    }
    const currentPeerId = normalizePeerId(peerId)
    if (!thesisId || !action) return NextResponse.json({ error: 'بيانات ناقصة' }, { status: 400 })

    const thesis = await getThesisForUser(thesisId, user.id, user.role)
    if (!thesis) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })

    if (action === 'join') {
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
      const role = user.role === 'STUDENT' ? 'STUDENT' : ['COMMITTEE', 'AGENT'].includes(body.role) ? body.role : 'COMMITTEE'
      const tz = String(body.tz || '').slice(0, 60) || null
      const p = await db.defenseParticipant.upsert({
        where: { peerId: currentPeerId },
        update: { name, role, tz, userId: user.id, lastSeenAt: new Date() },
        create: { thesisId, peerId: currentPeerId, userId: user.id, name, role, tz },
      })
      // تنظيف المشاركين القدماء غير النشطين لهذا البحث
      await db.defenseParticipant.deleteMany({
        where: { thesisId, lastSeenAt: { lt: new Date(Date.now() - 5 * 60000) } },
      })
      return NextResponse.json({ ok: true, peerId: p.peerId })
    }

    if (action === 'heartbeat') {
      if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      await requireOwnedParticipant(thesisId, currentPeerId, user.id)
      await db.defenseParticipant.updateMany({ where: { peerId: currentPeerId, thesisId, userId: user.id }, data: { lastSeenAt: new Date() } })
      return NextResponse.json({ ok: true })
    }

    if (action === 'leave') {
      if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      await requireOwnedParticipant(thesisId, currentPeerId, user.id)
      // بث مغادرة للجميع كنسخ موجهة حتى لا يستهلكها أول مشارك فقط
      await createDirectedOrFanoutSignal({ thesisId, fromPeer: currentPeerId, type: 'BYE', payload: {} })
      await db.defenseParticipant.deleteMany({ where: { peerId: currentPeerId, thesisId, userId: user.id } })
      return NextResponse.json({ ok: true })
    }

    if (action === 'signal') {
      if (!currentPeerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      await requireOwnedParticipant(thesisId, currentPeerId, user.id)
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
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('defense room POST error:', e)
    return NextResponse.json({ error: 'خطأ في قاعة المناقشة' }, { status: 500 })
  }
}
