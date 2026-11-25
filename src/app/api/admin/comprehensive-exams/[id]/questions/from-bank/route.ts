import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { toComprehensiveQuestionFromBankItem } from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'

// POST /api/admin/comprehensive-exams/[id]/questions/from-bank
// يستورد لقطات من أسئلة معتمدة في بنك الأسئلة لنفس البرنامج فقط
// (MCQ/TF فقط؛ SHORT/ESSAY تُرفض). اللقطة تبدأ APPROVED لأنها اعتُمدت
// أصلاً في البنك — وهي مصدر «الكتب المرفوعة»: البنك نفسه يُولَّد من الكتب.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, programId: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const body = await req.json()
    const bankItemIds: string[] = Array.isArray(body?.bankItemIds)
      ? [...new Set(body.bankItemIds.map((x: unknown) => String(x || '').trim()).filter(Boolean))].slice(0, 100)
      : []
    if (!bankItemIds.length) return NextResponse.json({ error: 'اختر سؤالاً واحداً على الأقل من بنك الأسئلة' }, { status: 400 })
    const bankItems = await db.questionBankItem.findMany({
      where: { id: { in: bankItemIds }, programId: exam.programId, status: 'APPROVED' },
      select: { id: true, type: true, text: true, options: true, correctAnswer: true, sourceEvidence: true, bookId: true },
    })
    const foundIds = new Set(bankItems.map((b: any) => b.id))
    const missing = bankItemIds.filter((x) => !foundIds.has(x))
    const mapped: any[] = []
    const refused: string[] = []
    for (const item of bankItems) {
      const row = toComprehensiveQuestionFromBankItem(item, 0)
      if (!row) {
        refused.push(item.id)
        continue
      }
      mapped.push(row)
    }
    if (!mapped.length) {
      return NextResponse.json(
        { error: 'لا يوجد سؤال صالح للاستيراد — تأكد أن الأسئلة معتمدة في البنك ومن نوع صح/خطأ أو اختيار متعدد', missing, refused },
        { status: 400 },
      )
    }
    const last = await db.comprehensiveExamQuestion.findFirst({
      where: { examId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    let order = last?.order ?? 0
    await db.comprehensiveExamQuestion.createMany({
      data: mapped.map((row) => ({ ...row, order: ++order, examId: id, createdById: admin.id })),
    })
    await db.questionBankItem.updateMany({
      where: { id: { in: mapped.map((r) => r.bankItemId) } },
      data: { usageCount: { increment: 1 } },
    })
    await audit(
      { id: admin.id, name: admin.name },
      'IMPORT_COMPREHENSIVE_EXAM_QUESTIONS_FROM_BANK',
      'ComprehensiveExam',
      id,
      `استيراد ${mapped.length} سؤالاً معتمداً من بنك الأسئلة إلى الامتحان الشامل «${exam.title}»`,
    )
    return NextResponse.json({ ok: true, imported: mapped.length, missing, refused })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam from-bank error:', e)
    return NextResponse.json({ error: 'تعذر الاستيراد من بنك الأسئلة' }, { status: 500 })
  }
}
