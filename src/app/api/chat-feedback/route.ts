import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin, requireUser } from '@/lib/auth'

const NEGATIVE_REASONS = new Set(['TOO_GENERAL', 'NOT_RELATED', 'UNCLEAR', 'WRONG', 'DID_NOT_ANSWER', 'WEAK_SOURCE', 'OTHER'])
const STATUSES = new Set(['NEW', 'IN_REVIEW', 'REVIEWED', 'IGNORED'])

function cleanText(value: unknown, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) || null
}

function normalizeRating(value: unknown) {
  const rating = String(value || '').trim().toUpperCase()
  if (rating === 'HELPFUL' || rating === 'NEEDS_REVIEW') return rating
  return null
}

async function inferStudentProgramId(userId: string) {
  const enrollment = await db.enrollment.findFirst({
    where: { userId, status: { not: 'PENDING_PAYMENT' } },
    orderBy: { createdAt: 'desc' },
    select: { programId: true },
  })
  return enrollment?.programId || null
}

// POST /api/chat-feedback — تقييم الطالب/المستخدم لرد المشرف الذكي
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const messageId = cleanText(body?.messageId, 80)
    const rating = normalizeRating(body?.rating)
    if (!messageId || !rating) {
      return NextResponse.json({ error: 'معرف الرد والتقييم مطلوبان' }, { status: 400 })
    }

    const msg = await db.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, userId: true, role: true, content: true },
    })
    if (!msg) return NextResponse.json({ error: 'الرد غير موجود' }, { status: 404 })
    if (msg.userId !== user.id && user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'لا يمكنك تقييم رد لا يخص محادثتك' }, { status: 403 })
    }
    if (msg.role !== 'assistant') {
      return NextResponse.json({ error: 'يمكن تقييم ردود المشرف الذكي فقط' }, { status: 400 })
    }

    const reasonRaw = cleanText(body?.reason, 40)
    const reason = rating === 'NEEDS_REVIEW' && reasonRaw && NEGATIVE_REASONS.has(reasonRaw) ? reasonRaw : null
    const note = cleanText(body?.note, 800)
    const programId = cleanText(body?.programId, 80) || await inferStudentProgramId(user.id)

    const feedback = await db.chatFeedback.upsert({
      where: { messageId_userId: { messageId: msg.id, userId: user.id } },
      create: {
        messageId: msg.id,
        userId: user.id,
        programId,
        rating,
        reason,
        note,
        status: rating === 'NEEDS_REVIEW' ? 'NEW' : 'REVIEWED',
      },
      update: {
        programId,
        rating,
        reason,
        note,
        status: rating === 'NEEDS_REVIEW' ? 'NEW' : 'REVIEWED',
        reviewedById: null,
        reviewedAt: null,
      },
    })

    return NextResponse.json({ ok: true, feedback })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('chat feedback POST error:', e)
    return NextResponse.json({ error: 'تعذر حفظ تقييم الرد' }, { status: 500 })
  }
}

// GET /api/chat-feedback — لوحة الإدارة: ردود تحتاج مراجعة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const status = String(req.nextUrl.searchParams.get('status') || '').toUpperCase()
    const where: any = { rating: 'NEEDS_REVIEW' }
    if (STATUSES.has(status)) where.status = status

    const rows = await db.chatFeedback.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 80,
      include: {
        user: { select: { id: true, name: true, email: true } },
        message: { select: { id: true, content: true, createdAt: true, userId: true } },
      },
    })

    const programIds = Array.from(new Set(rows.map((r) => r.programId).filter(Boolean))) as string[]
    const programs = programIds.length
      ? await db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true, category: true } })
      : []
    const programMap = new Map(programs.map((p) => [p.id, p]))

    const previousUserMessages = await Promise.all(rows.map(async (row) => {
      const prev = await db.chatMessage.findFirst({
        where: { userId: row.message.userId, role: 'user', createdAt: { lt: row.message.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { content: true, createdAt: true },
      })
      return [row.id, prev] as const
    }))
    const previousMap = new Map(previousUserMessages)

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        messageId: row.messageId,
        rating: row.rating,
        reason: row.reason,
        note: row.note,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        student: row.user,
        program: row.programId ? programMap.get(row.programId) || null : null,
        question: previousMap.get(row.id)?.content || null,
        answer: row.message.content,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('chat feedback GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل ردود المشرف التي تحتاج مراجعة' }, { status: 500 })
  }
}

// PATCH /api/chat-feedback — تحديث حالة المراجعة من الإدارة
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const id = cleanText(body?.id, 80)
    const status = String(body?.status || '').trim().toUpperCase()
    if (!id || !STATUSES.has(status)) return NextResponse.json({ error: 'الحالة غير صحيحة' }, { status: 400 })

    const updated = await db.chatFeedback.update({
      where: { id },
      data: {
        status,
        reviewedById: admin.id,
        reviewedAt: status === 'NEW' ? null : new Date(),
      },
    })
    return NextResponse.json({ ok: true, item: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('chat feedback PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث حالة المراجعة' }, { status: 500 })
  }
}
