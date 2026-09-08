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
    const peerId = req.nextUrl.searchParams.get('peerId')
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })

    const thesis = await getThesisForUser(thesisId, user.id, user.role)
    if (!thesis) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })

    const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS)
    const participants = await db.defenseParticipant.findMany({
      where: { thesisId, lastSeenAt: { gte: cutoff } },
      orderBy: { joinedAt: 'asc' },
    })

    // الإشارات الموجهة لي أو المبثوة للجميع (غير المرسلة مني)
    let signals: any[] = []
    if (peerId) {
      const rows = await db.defenseSignal.findMany({
        where: {
          thesisId,
          consumed: false,
          fromPeer: { not: peerId },
          OR: [{ toPeer: null }, { toPeer: peerId }],
        },
        orderBy: { createdAt: 'asc' },
        take: 60,
      })
      signals = rows
      await db.defenseSignal.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { consumed: true },
      })
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
    if (!thesisId || !action) return NextResponse.json({ error: 'بيانات ناقصة' }, { status: 400 })

    const thesis = await getThesisForUser(thesisId, user.id, user.role)
    if (!thesis) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذه القاعة' }, { status: 403 })

    if (action === 'join') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      // الدور يُحسب خادمياً من حساب المستخدم — لا يُقبل دور من العميل (منع انتحال صفة اللجنة)
      const name = String(user.role === 'STUDENT' ? user.name : body.name || user.name)
        .slice(0, 80)
      const role = user.role === 'STUDENT' ? 'STUDENT' : ['COMMITTEE', 'AGENT'].includes(body.role) ? body.role : 'COMMITTEE'
      const tz = String(body.tz || '').slice(0, 60) || null
      const p = await db.defenseParticipant.upsert({
        where: { peerId },
        update: { name, role, tz, lastSeenAt: new Date() },
        create: { thesisId, peerId, userId: user.id, name, role, tz },
      })
      // تنظيف المشاركين القدماء غير النشطين لهذا البحث
      await db.defenseParticipant.deleteMany({
        where: { thesisId, lastSeenAt: { lt: new Date(Date.now() - 5 * 60000) } },
      })
      return NextResponse.json({ ok: true, peerId: p.peerId })
    }

    if (action === 'heartbeat') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      await db.defenseParticipant.updateMany({ where: { peerId, thesisId }, data: { lastSeenAt: new Date() } })
      return NextResponse.json({ ok: true })
    }

    if (action === 'leave') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      // بث مغادرة للجميع ثم حذف المشارك
      await db.defenseSignal.create({
        data: { thesisId, fromPeer: peerId, toPeer: null, type: 'BYE', payload: '{}' },
      })
      await db.defenseParticipant.deleteMany({ where: { peerId, thesisId } })
      return NextResponse.json({ ok: true })
    }

    if (action === 'signal') {
      if (!peerId) return NextResponse.json({ error: 'معرف الاتصال مطلوب' }, { status: 400 })
      const { type, payload, to } = body as { type: string; payload: any; to?: string | null }
      if (!['OFFER', 'ANSWER', 'ICE', 'BYE'].includes(type)) {
        return NextResponse.json({ error: 'نوع إشارة غير معروف' }, { status: 400 })
      }
      await db.defenseSignal.create({
        data: { thesisId, fromPeer: peerId, toPeer: to || null, type, payload: JSON.stringify(payload || {}) },
      })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('defense room POST error:', e)
    return NextResponse.json({ error: 'خطأ في قاعة المناقشة' }, { status: 500 })
  }
}
