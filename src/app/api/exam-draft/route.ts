import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

type ExamType = 'UNIT' | 'PROGRAM'

const MAX_ANSWERS_JSON = 220_000

function normalizeExamType(value: string | null): ExamType | null {
  const v = String(value || '').trim().toUpperCase()
  if (v === 'UNIT' || v === 'EXAM') return 'UNIT'
  if (v === 'PROGRAM' || v === 'FINAL') return 'PROGRAM'
  return null
}

function safeAnswersJson(value: unknown) {
  const answers = Array.isArray(value) ? value : []
  const cleaned = answers.slice(0, 300).map((a: any) => ({
    questionId: String(a?.questionId || '').slice(0, 80),
    selectedOption: typeof a?.selectedOption === 'number' && Number.isFinite(a.selectedOption) ? a.selectedOption : undefined,
    answerText: typeof a?.answerText === 'string' ? a.answerText.slice(0, 12000) : undefined,
  })).filter((a) => a.questionId)
  const json = JSON.stringify(cleaned)
  if (json.length > MAX_ANSWERS_JSON) throw new Error('DRAFT_TOO_LARGE')
  return json
}

async function assertExamAccess(userId: string, examId: string, examType: ExamType) {
  if (examType === 'UNIT') {
    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: { unit: { select: { programId: true } } },
    })
    if (!exam) return { ok: false as const, status: 404, error: 'الاختبار غير موجود' }
    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId, programId: exam.unit.programId } },
      select: { status: true },
    })
    if (!enrollment) return { ok: false as const, status: 403, error: 'يجب التسجيل في البرنامج أولاً' }
    if (enrollment.status === 'PENDING_PAYMENT') return { ok: false as const, status: 402, error: 'تسجيلك بانتظار سداد الفاتورة' }
    return { ok: true as const }
  }

  const exam = await db.programExam.findUnique({
    where: { id: examId },
    select: { programId: true, status: true },
  })
  if (!exam) return { ok: false as const, status: 404, error: 'الاختبار غير موجود' }
  if (exam.status !== 'READY') return { ok: false as const, status: 400, error: 'الاختبار غير متاح حالياً' }
  const enrollment = await db.enrollment.findUnique({
    where: { userId_programId: { userId, programId: exam.programId } },
    select: { status: true },
  })
  if (!enrollment) return { ok: false as const, status: 403, error: 'يجب التسجيل في البرنامج أولاً' }
  if (enrollment.status === 'PENDING_PAYMENT') return { ok: false as const, status: 402, error: 'تسجيلك بانتظار سداد الفاتورة' }
  return { ok: true as const }
}

// GET /api/exam-draft?examId=...&examType=UNIT|PROGRAM
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const examId = String(req.nextUrl.searchParams.get('examId') || '').trim()
    const examType = normalizeExamType(req.nextUrl.searchParams.get('examType'))
    if (!examId || !examType) return NextResponse.json({ error: 'معرف الاختبار ونوعه مطلوبان' }, { status: 400 })

    const access = await assertExamAccess(user.id, examId, examType)
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status })

    const draft = await db.examDraft.findUnique({
      where: { userId_examId_examType: { userId: user.id, examId, examType } },
    })
    if (!draft) return NextResponse.json({ draft: null })

    let answers: any[] = []
    try { answers = JSON.parse(draft.answersJson || '[]') } catch {}
    return NextResponse.json({
      draft: {
        examId: draft.examId,
        examType: draft.examType,
        answers,
        current: draft.current,
        startedAtMs: draft.startedAtMs,
        updatedAt: draft.updatedAt,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('exam draft GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مسودة الاختبار' }, { status: 500 })
  }
}

// POST /api/exam-draft — يحفظ/يحدث مسودة الإجابات السحابية
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const examId = String(body?.examId || '').trim()
    const examType = normalizeExamType(body?.examType)
    if (!examId || !examType) return NextResponse.json({ error: 'معرف الاختبار ونوعه مطلوبان' }, { status: 400 })

    const access = await assertExamAccess(user.id, examId, examType)
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status })

    const answersJson = safeAnswersJson(body?.answers)
    const current = Math.max(0, Math.min(500, Number(body?.current || 0)))
    const startedAtMs = body?.startedAtMs ? String(body.startedAtMs).slice(0, 32) : null

    const draft = await db.examDraft.upsert({
      where: { userId_examId_examType: { userId: user.id, examId, examType } },
      create: { userId: user.id, examId, examType, answersJson, current, startedAtMs },
      update: { answersJson, current, startedAtMs },
    })

    return NextResponse.json({ ok: true, updatedAt: draft.updatedAt })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    if (e?.message === 'DRAFT_TOO_LARGE') return NextResponse.json({ error: 'حجم مسودة الإجابات كبير جداً' }, { status: 413 })
    console.error('exam draft POST error:', e)
    return NextResponse.json({ error: 'تعذر حفظ مسودة الاختبار' }, { status: 500 })
  }
}

// DELETE /api/exam-draft?examId=...&examType=UNIT|PROGRAM — ينظف المسودة بعد التسليم الناجح
export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser()
    const examId = String(req.nextUrl.searchParams.get('examId') || '').trim()
    const examType = normalizeExamType(req.nextUrl.searchParams.get('examType'))
    if (!examId || !examType) return NextResponse.json({ error: 'معرف الاختبار ونوعه مطلوبان' }, { status: 400 })

    await db.examDraft.deleteMany({ where: { userId: user.id, examId, examType } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('exam draft DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف مسودة الاختبار' }, { status: 500 })
  }
}
