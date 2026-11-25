import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { comprehensiveQuestionCounts } from '@/lib/comprehensive-exam'
import { programSpecialtyLabel, PROGRAM_CATEGORY_AR } from '@/lib/program-tracks'

export const runtime = 'nodejs'

function cleanText(value: unknown, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safePassScore(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : null
}

function safeDurationMin(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(10, Math.min(480, Math.floor(n))) : null
}

// GET /api/admin/comprehensive-exams/[id] — التفاصيل + الأسئلة + العدّادات
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      include: {
        program: { select: { id: true, titleAr: true, titleEn: true, slug: true, category: true } },
        questions: { orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    return NextResponse.json({
      ok: true,
      exam: {
        id: exam.id,
        programId: exam.programId,
        programTitleAr: exam.program.titleAr,
        programCategory: exam.program.category,
        categoryLabel: PROGRAM_CATEGORY_AR[exam.program.category] || exam.program.category,
        specialtyLabel: programSpecialtyLabel({ titleAr: exam.program.titleAr, category: exam.program.category }),
        level: exam.level,
        title: exam.title,
        status: exam.status,
        passScore: exam.passScore,
        durationMin: exam.durationMin,
        totalPoints: exam.totalPoints,
        publishedAt: exam.publishedAt,
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
      },
      counts: comprehensiveQuestionCounts(exam.questions),
      questions: exam.questions.map((q: any) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        options: q.options,
        correctAnswer: q.correctAnswer,
        source: q.source,
        sourceBookId: q.sourceBookId,
        sourceEvidence: q.sourceEvidence,
        bankItemId: q.bankItemId,
        status: q.status,
        rejectedReason: q.rejectedReason,
        createdAt: q.createdAt,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam detail error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الامتحان الشامل' }, { status: 500 })
  }
}

// PATCH /api/admin/comprehensive-exams/[id] — تعديل إعدادات المسودة فقط
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const body = await req.json()
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true, status: true, title: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن تعديل امتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const data: Record<string, unknown> = {}
    const passScore = body?.passScore !== undefined ? safePassScore(body.passScore) : null
    const durationMin = body?.durationMin !== undefined ? safeDurationMin(body.durationMin) : null
    if (passScore !== null) data.passScore = passScore
    if (durationMin !== null) data.durationMin = durationMin
    const title = body?.title !== undefined ? cleanText(body.title, 200) : ''
    if (title) data.title = title
    if (!Object.keys(data).length) return NextResponse.json({ error: 'لا يوجد ما يُعدَّل' }, { status: 400 })
    const updated = await db.comprehensiveExam.update({ where: { id }, data })
    await audit(
      { id: admin.id, name: admin.name },
      'UPDATE_COMPREHENSIVE_EXAM',
      'ComprehensiveExam',
      id,
      `تعديل إعدادات مسودة الامتحان الشامل «${exam.title}»`,
    )
    return NextResponse.json({ ok: true, exam: { id: updated.id, status: updated.status, passScore: updated.passScore, durationMin: updated.durationMin, title: updated.title } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam update error:', e)
    return NextResponse.json({ error: 'تعذر تعديل الامتحان الشامل' }, { status: 500 })
  }
}
