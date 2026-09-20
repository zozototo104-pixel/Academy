import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function norm(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function questionStats(programId: string) {
  const rows = await db.questionBankItem.findMany({ where: { programId }, select: { status: true, difficulty: true, type: true } })
  return {
    total: rows.length,
    pending: rows.filter((x) => x.status === 'PENDING_REVIEW').length,
    approved: rows.filter((x) => x.status === 'APPROVED').length,
    rejected: rows.filter((x) => x.status === 'REJECTED').length,
    byDifficulty: {
      EASY: rows.filter((x) => x.difficulty === 'EASY').length,
      MEDIUM: rows.filter((x) => x.difficulty === 'MEDIUM').length,
      ADVANCED: rows.filter((x) => x.difficulty === 'ADVANCED').length,
    },
    byType: {
      MCQ: rows.filter((x) => x.type === 'MCQ').length,
      TF: rows.filter((x) => x.type === 'TF').length,
      SHORT: rows.filter((x) => x.type === 'SHORT').length,
      ESSAY: rows.filter((x) => x.type === 'ESSAY').length,
    },
  }
}

async function listQuestions(programId: string) {
  return db.questionBankItem.findMany({ where: { programId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 120 })
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const exams = await db.programExam.findMany({
      where: { programId },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        status: true,
        semester: true,
        createdAt: true,
        questions: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            order: true,
            type: true,
            text: true,
            options: true,
            correctAnswer: true,
            modelAnswer: true,
            sourceEvidence: true,
            sourceBookTitle: true,
            sourceLocator: true,
            cognitiveSkill: true,
            difficulty: true,
            correctRationale: true,
            distractorRationales: true,
            qualityFlags: true,
            points: true,
            status: true,
          },
        },
      },
    })

    return NextResponse.json({ exams })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank from exam GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أسئلة الاختبارات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const examId = cleanText(body?.examId, 80)
    const questionIds = Array.isArray(body?.questionIds) ? body.questionIds.map((x: any) => cleanText(x, 80)).filter(Boolean) : []
    const approveNow = body?.approveNow === true
    if (!programId || !examId || questionIds.length === 0) return NextResponse.json({ error: 'اختر البرنامج والاختبار والأسئلة المراد نسخها' }, { status: 400 })

    const exam = await db.programExam.findFirst({
      where: { id: examId, programId },
      select: { id: true, title: true, semester: true, questions: { where: { id: { in: questionIds } }, orderBy: { order: 'asc' } } },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود لهذا البرنامج' }, { status: 404 })

    const existing = await db.questionBankItem.findMany({ where: { programId }, select: { text: true } })
    const seen = new Set(existing.map((q) => norm(q.text)))
    const rows: any[] = []
    let skippedDuplicates = 0

    for (const q of exam.questions) {
      const key = norm(q.text)
      if (!key || seen.has(key)) { skippedDuplicates++; continue }
      seen.add(key)
      rows.push({
        programId,
        semester: exam.semester || null,
        type: q.type,
        text: q.text,
        options: q.options,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer,
        sourceEvidence: q.sourceEvidence,
        sourceBookTitle: q.sourceBookTitle,
        sourceLocator: q.sourceLocator || exam.title,
        cognitiveSkill: q.cognitiveSkill,
        difficulty: q.difficulty || 'MEDIUM',
        correctRationale: q.correctRationale,
        distractorRationales: q.distractorRationales,
        qualityFlags: q.qualityFlags || JSON.stringify(['COPIED_FROM_EXAM', 'NEEDS_HUMAN_REVIEW']),
        status: approveNow ? 'APPROVED' : 'PENDING_REVIEW',
        generatedBy: 'EXAM_COPY',
        qualityScore: approveNow ? 85 : 70,
        approvedAt: approveNow ? new Date() : null,
        approvedBy: approveNow ? admin.id : null,
      })
    }

    if (rows.length > 0) await db.questionBankItem.createMany({ data: rows })
    if (!rows.length) return NextResponse.json({ error: 'لم يتم نسخ أسئلة جديدة؛ قد تكون كلها موجودة سابقاً في البنك.', inserted: 0, skippedDuplicates }, { status: 409 })

    await audit({ id: admin.id, name: admin.name }, 'COPY_EXAM_TO_QUESTION_BANK', 'ProgramExam', exam.id, `نسخ ${rows.length} سؤالاً من اختبار ${exam.title} إلى بنك الأسئلة، وتجاوز ${skippedDuplicates} مكرر`)

    return NextResponse.json({ ok: true, inserted: rows.length, skippedDuplicates, stats: await questionStats(programId), items: await listQuestions(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank from exam POST error:', e)
    return NextResponse.json({ error: 'تعذر نسخ أسئلة الاختبار إلى بنك الأسئلة' }, { status: 500 })
  }
}
