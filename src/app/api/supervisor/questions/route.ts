import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, notifyAdmins } from '@/lib/notify'
import { canAccessProgram, requireSupervisor, type SupervisorActor } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// أسئلة المشرف اليدوية — بقرار هاريس: إضافة/تعديل مباشر يسري فورًا بلا
// اعتماد مسبق من الإدارة، مقابل إشعار للإدارة بكل عملية + سجل تدقيق.
// النوعان: BANK = سؤال بنك وحدة (يدخل حزمة الوحدة المعتمدة كما عند
// الإدارة)، PROGRAM = سؤال حي داخل امتحان فصلي قائم.

const TYPES = ['MCQ', 'TF', 'SHORT', 'ESSAY']

function clean(value: unknown, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function snippet(text: string) {
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((o) => clean(o, 500)).filter(Boolean)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((o) => clean(o, 500)).filter(Boolean)
    } catch { /* نص بصيغة أسطر */ }
    return raw.split('\n').map((o) => clean(o, 500)).filter(Boolean)
  }
  return []
}

function validateQuestionFields(body: any): { error?: string; data?: any } {
  const type = clean(body?.type, 20).toUpperCase() || 'MCQ'
  if (!TYPES.includes(type)) return { error: 'نوع السؤال غير صالح' }
  const text = clean(body?.text, 3000)
  if (!text) return { error: 'نص السؤال مطلوب' }
  const options = parseOptions(body?.options)
  const correctAnswer = body?.correctAnswer == null ? null : String(body.correctAnswer).trim()
  const modelAnswer = clean(body?.modelAnswer, 4000) || null
  if ((type === 'MCQ' || type === 'TF')) {
    if (options.length < 2) return { error: 'سؤال الاختيار يحتاج خيارين على الأقل' }
    if (correctAnswer == null || correctAnswer === '' || Number.isNaN(Number(correctAnswer)) || Number(correctAnswer) < 0 || Number(correctAnswer) >= options.length) {
      return { error: 'حدد الإجابة الصحيحة من بين الخيارات — التصحيح الآلي يعتمد عليها' }
    }
  }
  if ((type === 'ESSAY' || type === 'SHORT') && !modelAnswer) {
    return { error: 'السؤال المقالي/القصير يحتاج إجابة نموذجية — الذكاء يصحح على أساسها' }
  }
  const pointsRaw = Number(body?.points)
  const points = Number.isFinite(pointsRaw) && pointsRaw > 0 ? Math.max(1, Math.min(50, Math.round(pointsRaw))) : undefined
  return {
    data: {
      type,
      text,
      options: options.length ? JSON.stringify(options) : null,
      correctAnswer: correctAnswer || null,
      modelAnswer,
      rubric: clean(body?.rubric, 2000) || null,
      difficulty: ['EASY', 'MEDIUM', 'ADVANCED'].includes(clean(body?.difficulty, 20).toUpperCase()) ? clean(body?.difficulty, 20).toUpperCase() : 'MEDIUM',
      points,
    },
  }
}

async function notifyQuestionChange(actor: SupervisorActor, action: 'ADD' | 'EDIT' | 'DELETE', programTitle: string, where: string, text: string) {
  const verb = action === 'ADD' ? 'أضاف سؤالًا يدويًا' : action === 'EDIT' ? 'عدّل سؤالًا' : 'حذف سؤالًا'
  await notifyAdmins('GENERAL', 'تعديل مشرف على الأسئلة', `${actor.name} ${verb} في ${where} — برنامج «${programTitle}»: «${snippet(text)}»`, 'admin')
  await audit(
    { id: actor.id, name: actor.name },
    action === 'ADD' ? 'SUPERVISOR_ADD_QUESTION' : action === 'EDIT' ? 'SUPERVISOR_EDIT_QUESTION' : 'SUPERVISOR_DELETE_QUESTION',
    'Program',
    undefined,
    `${verb} في ${where} — ${programTitle}: ${snippet(text)}`,
  )
}

async function refreshProgramExamTotals(examId: string) {
  const agg = await db.programQuestion.aggregate({ where: { examId, status: 'PUBLISHED' }, _sum: { points: true } })
  await db.programExam.update({ where: { id: examId }, data: { totalPoints: agg._sum.points || 0 } }).catch(() => {})
}

// POST /api/supervisor/questions — إنشاء سؤال يدوي (BANK | PROGRAM)
export async function POST(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const kind = clean(body?.kind, 20).toUpperCase()
    const v = validateQuestionFields(body)
    if (v.error) return NextResponse.json({ error: v.error }, { status: 400 })
    const q = v.data

    if (kind === 'BANK') {
      const unitId = clean(body?.unitId, 100)
      if (!unitId) return NextResponse.json({ error: 'الوحدة مطلوبة لسؤال البنك' }, { status: 400 })
      const unit = await db.unit.findUnique({ where: { id: unitId }, select: { id: true, title: true, programId: true, program: { select: { titleAr: true } } } })
      if (!unit) return NextResponse.json({ error: 'الوحدة غير موجودة' }, { status: 404 })
      if (!(await canAccessProgram(actor, unit.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      const duplicate = await db.questionBankItem.findFirst({ where: { programId: unit.programId, unitId, text: q.text }, select: { id: true } })
      if (duplicate) return NextResponse.json({ error: 'هذا السؤال موجود أصلًا في بنك الوحدة' }, { status: 409 })
      const sourceEvidence = clean(body?.sourceEvidence, 2500) || null
      const item = await db.questionBankItem.create({
        data: {
          programId: unit.programId,
          unitId,
          type: q.type,
          text: q.text,
          options: q.options,
          correctAnswer: q.correctAnswer,
          modelAnswer: q.modelAnswer,
          rubric: q.rubric,
          difficulty: q.difficulty,
          sourceEvidence,
          generatedBy: 'MANUAL',
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          qualityFlags: JSON.stringify(sourceEvidence ? ['MANUAL', 'SOURCE_GROUNDED'] : ['MANUAL']),
          reviewNotes: JSON.stringify({ manualBy: { supervisorId: actor.id, supervisorName: actor.name } }),
        },
      })
      await notifyQuestionChange(actor, 'ADD', unit.program.titleAr, `بنك وحدة «${unit.title}»`, q.text)
      return NextResponse.json({ ok: true, question: item })
    }

    if (kind === 'PROGRAM') {
      const examId = clean(body?.examId, 100)
      if (!examId) return NextResponse.json({ error: 'الامتحان مطلوب' }, { status: 400 })
      const exam = await db.programExam.findUnique({ where: { id: examId }, select: { id: true, title: true, programId: true, program: { select: { titleAr: true } }, _count: { select: { questions: true } } } })
      if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (!(await canAccessProgram(actor, exam.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      const last = await db.programQuestion.findFirst({ where: { examId }, orderBy: { order: 'desc' }, select: { order: true } })
      const item = await db.programQuestion.create({
        data: {
          examId,
          order: (last?.order ?? 0) + 1,
          type: q.type,
          text: q.text,
          options: q.options,
          correctAnswer: q.correctAnswer,
          modelAnswer: q.modelAnswer,
          rubric: q.rubric,
          difficulty: q.difficulty,
          points: q.points ?? 2,
          status: 'PUBLISHED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          reviewNotes: `أضافه المشرف ${actor.name} يدويًا`,
        },
      })
      await refreshProgramExamTotals(examId)
      await notifyQuestionChange(actor, 'ADD', exam.program.titleAr, `الامتحان الفصلي «${exam.title}»`, q.text)
      return NextResponse.json({ ok: true, question: item })
    }

    return NextResponse.json({ error: 'نوع الهدف غير صالح' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor questions POST error:', e)
    return NextResponse.json({ error: 'تعذر إضافة السؤال' }, { status: 500 })
  }
}

// PATCH /api/supervisor/questions — تعديل سؤال قائم (BANK | PROGRAM)
export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const kind = clean(body?.kind, 20).toUpperCase()
    const questionId = clean(body?.questionId, 100)
    if (!questionId) return NextResponse.json({ error: 'معرف السؤال مطلوب' }, { status: 400 })
    const v = validateQuestionFields(body)
    if (v.error) return NextResponse.json({ error: v.error }, { status: 400 })
    const q = v.data

    if (kind === 'BANK') {
      const item = await db.questionBankItem.findUnique({ where: { id: questionId }, select: { id: true, programId: true, unitId: true, text: true, program: { select: { titleAr: true } } } })
      if (!item) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
      if (!(await canAccessProgram(actor, item.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      const updated = await db.questionBankItem.update({
        where: { id: questionId },
        data: { type: q.type, text: q.text, options: q.options, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, rubric: q.rubric, difficulty: q.difficulty },
      })
      await notifyQuestionChange(actor, 'EDIT', item.program.titleAr, `بنك الوحدة`, q.text)
      return NextResponse.json({ ok: true, question: updated })
    }

    if (kind === 'PROGRAM') {
      const item = await db.programQuestion.findUnique({ where: { id: questionId }, select: { id: true, text: true, exam: { select: { id: true, title: true, programId: true, program: { select: { titleAr: true } } } } } })
      if (!item) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
      if (!(await canAccessProgram(actor, item.exam.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      const data: any = { type: q.type, text: q.text, options: q.options, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, rubric: q.rubric, difficulty: q.difficulty }
      if (q.points != null) data.points = q.points
      const updated = await db.programQuestion.update({ where: { id: questionId }, data })
      await refreshProgramExamTotals(item.exam.id)
      await notifyQuestionChange(actor, 'EDIT', item.exam.program.titleAr, `الامتحان الفصلي «${item.exam.title}»`, q.text)
      return NextResponse.json({ ok: true, question: updated })
    }

    return NextResponse.json({ error: 'نوع الهدف غير صالح' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor questions PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تعديل السؤال' }, { status: 500 })
  }
}

// DELETE /api/supervisor/questions — حذف؛ سؤال الامتحان الفصلي الذي
// أجاب عليه طالب لا يُحذف (يكسر محاولته)، وبنك الوحدات يُحذف بحرية
// لأن الامتحانات المبنية نسخ مستقلة.
export async function DELETE(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const kind = clean(body?.kind, 20).toUpperCase()
    const questionId = clean(body?.questionId, 100)
    if (!questionId) return NextResponse.json({ error: 'معرف السؤال مطلوب' }, { status: 400 })

    if (kind === 'BANK') {
      const item = await db.questionBankItem.findUnique({ where: { id: questionId }, select: { id: true, programId: true, unitId: true, text: true, program: { select: { titleAr: true } } } })
      if (!item) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
      if (!(await canAccessProgram(actor, item.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      await db.questionBankItem.delete({ where: { id: questionId } })
      await notifyQuestionChange(actor, 'DELETE', item.program.titleAr, `بنك الوحدة`, item.text)
      return NextResponse.json({ ok: true })
    }

    if (kind === 'PROGRAM') {
      const item = await db.programQuestion.findUnique({ where: { id: questionId }, select: { id: true, text: true, exam: { select: { id: true, title: true, programId: true, program: { select: { titleAr: true } } } } } })
      if (!item) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
      if (!(await canAccessProgram(actor, item.exam.programId))) return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
      const answered = await db.programAnswer.count({ where: { questionId } })
      if (answered > 0) return NextResponse.json({ error: 'لا يمكن حذف سؤال أجاب عليه طلاب — عدّله بدل حذفه، أو راسل الإدارة' }, { status: 409 })
      await db.programQuestion.delete({ where: { id: questionId } })
      await refreshProgramExamTotals(item.exam.id)
      await notifyQuestionChange(actor, 'DELETE', item.exam.program.titleAr, `الامتحان الفصلي «${item.exam.title}»`, item.text)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'نوع الهدف غير صالح' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor questions DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف السؤال' }, { status: 500 })
  }
}
