import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'

function cleanText(value: unknown, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeQuestionText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeQuestionCount(value: unknown) {
  return Math.max(5, Math.min(80, Number(value || 30)))
}

function safeSemester(value: unknown) {
  const n = Number(value || 1)
  return n > 1 ? 2 : 1
}

function normalizePlan(value: any, total: number, fallback: Record<string, number>) {
  const source = value && typeof value === 'object' ? value : fallback
  const raw = Object.entries(source).map(([key, v]) => ({ key: key.toUpperCase(), count: Math.max(0, Math.floor(Number(v || 0))) }))
  const sum = raw.reduce((s, x) => s + x.count, 0)
  if (sum <= 0) return Object.entries(fallback).map(([key, count]) => ({ key, count }))
  const scaled = raw.map((x) => ({ key: x.key, count: Math.floor((x.count / sum) * total) }))
  let diff = total - scaled.reduce((s, x) => s + x.count, 0)
  for (const item of scaled) {
    if (diff <= 0) break
    item.count++
    diff--
  }
  return scaled
}

function distributeTake<T extends { difficulty?: string | null; type?: string | null }>(rows: T[], count: number, difficultyPlan?: any, typePlan?: any) {
  const selected: T[] = []
  const seen = new Set<string>()

  const diffTargets = normalizePlan(difficultyPlan, count, { MEDIUM: 50, EASY: 25, ADVANCED: 25 })
  const typeTargets = typePlan ? normalizePlan(typePlan, count, { MCQ: 50, TF: 20, SHORT: 20, ESSAY: 10 }) : []

  function add(q: T) {
    const key = normalizeQuestionText((q as any).text).slice(0, 180)
    if (!key || seen.has(key) || selected.length >= count) return false
    seen.add(key)
    selected.push(q)
    return true
  }

  if (typeTargets.length > 0) {
    for (const t of typeTargets) {
      const candidates = rows.filter((q) => String(q.type || '').toUpperCase() === t.key)
      for (const q of candidates.slice(0, t.count)) add(q)
    }
  }

  for (const t of diffTargets) {
    const candidates = rows.filter((q) => String(q.difficulty || 'MEDIUM').toUpperCase() === t.key)
    for (const q of candidates.slice(0, t.count)) add(q)
  }
  for (const q of rows) add(q)
  return selected.slice(0, count)
}

function pointsForType(type: string) {
  if (type === 'ESSAY') return 5
  if (type === 'SHORT') return 3
  return 2
}

// POST /api/admin/program-exams/from-question-bank
// ينشئ امتحاناً جديداً من الأسئلة المعتمدة في بنك الأسئلة المركزي لنفس البرنامج فقط.
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const semester = safeSemester(body?.semester)
    const requestedCount = safeQuestionCount(body?.count)
    const includeAllSemesters = body?.includeAllSemesters === true
    const replaceExistingReview = body?.replaceExistingReview === true
    const unitId = cleanText(body?.unitId, 80) || null
    const difficultyPlan = body?.difficultyPlan
    const typePlan = body?.typePlan

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const existingSemExam = await db.programExam.findFirst({
      where: { programId, semester, status: { in: ['REVIEW', 'READY'] } },
      include: { _count: { select: { questions: true } } },
    })
    if (existingSemExam) {
      if (existingSemExam.status === 'READY') {
        return NextResponse.json({ error: 'يوجد امتحان منشور لهذا الفصل. لا يمكن استبداله من بنك الأسئلة إلا بعد حذفه أو إلغاء نشره من المسار الإداري المناسب.' }, { status: 409 })
      }
      if (!replaceExistingReview) {
        return NextResponse.json({ error: 'يوجد امتحان بانتظار المراجعة لهذا الفصل. فعّل خيار الاستبدال إذا أردت إنشاء نسخة جديدة من بنك الأسئلة.', examId: existingSemExam.id }, { status: 409 })
      }
      await db.programQuestion.deleteMany({ where: { examId: existingSemExam.id } })
      await db.programExam.delete({ where: { id: existingSemExam.id } })
    }

    const bankQuestions = await db.questionBankItem.findMany({
      where: {
        programId,
        status: 'APPROVED',
        ...(unitId ? { unitId } : {}),
        ...(includeAllSemesters || unitId ? {} : { OR: [{ semester: null }, { semester }] }),
      },
      orderBy: [{ usageCount: 'asc' }, { difficulty: 'asc' }, { createdAt: 'desc' }],
      take: Math.max(requestedCount * 3, 120),
    })

    if (bankQuestions.length === 0) {
      return NextResponse.json({ error: 'لا توجد أسئلة معتمدة في بنك الأسئلة لهذا البرنامج/الفصل. اعتمد أسئلة في بنك الأسئلة أولاً.' }, { status: 400 })
    }

    const selected = distributeTake(bankQuestions, requestedCount, difficultyPlan, typePlan)
    if (selected.length < Math.min(5, requestedCount)) {
      return NextResponse.json({ error: `عدد الأسئلة المعتمدة غير كافٍ. المتاح: ${selected.length} سؤال.` }, { status: 400 })
    }

    const semLabel = semester === 2 ? 'الثاني' : 'الأول'
    const exam = await db.programExam.create({
      data: {
        programId,
        semester,
        title: `امتحان الفصل الدراسي ${semLabel} من بنك الأسئلة — ${program.titleAr}`,
        status: 'REVIEW',
        durationMin: Math.max(60, Math.min(240, Math.round(selected.length * 2.5))),
        generatedBy: 'QUESTION_BANK',
        booksUsed: 'بنك الأسئلة المركزي المعتمد لهذا البرنامج',
      },
    })

    let order = 0
    await db.programQuestion.createMany({
      data: selected.map((q) => ({
        examId: exam.id,
        order: ++order,
        type: q.type,
        text: q.text,
        options: q.options,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer,
        sourceEvidence: q.sourceEvidence,
        sourceBookTitle: q.sourceBookTitle,
        sourceLocator: q.sourceLocator,
        cognitiveSkill: q.cognitiveSkill,
        difficulty: q.difficulty,
        correctRationale: q.correctRationale,
        distractorRationales: q.distractorRationales,
        qualityFlags: q.qualityFlags,
        points: pointsForType(q.type),
        status: 'PENDING_REVIEW',
      })),
    })

    const totalPoints = selected.reduce((sum, q) => sum + pointsForType(q.type), 0)
    await db.programExam.update({ where: { id: exam.id }, data: { totalPoints } })
    await db.questionBankItem.updateMany({ where: { id: { in: selected.map((q) => q.id) } }, data: { usageCount: { increment: 1 } } })

    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_PROGRAM_EXAM_FROM_QUESTION_BANK',
      'ProgramExam',
      exam.id,
      `إنشاء امتحان الفصل ${semLabel} لبرنامج ${program.titleAr} من ${selected.length} سؤالاً معتمداً في بنك الأسئلة المركزي`
    )

    return NextResponse.json({
      ok: true,
      examId: exam.id,
      status: 'REVIEW',
      questionCount: selected.length,
      totalPoints,
      availableApproved: bankQuestions.length,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program exam from question bank error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء الامتحان من بنك الأسئلة المركزي' }, { status: 500 })
  }
}
