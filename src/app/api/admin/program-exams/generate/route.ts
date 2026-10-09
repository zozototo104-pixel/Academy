import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/notify'
import { ensureQuestionBankGenerationJob, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const runtime = 'nodejs'
export const maxDuration = 300

function clean(value: unknown, max = 1200) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) }
function parseArray(value: unknown): any[] { if (Array.isArray(value)) return value; if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] } } return [] }
function hasFlag(value: unknown, flag: string) { return parseArray(value).map(String).includes(flag) }

function shuffleWithAnswer(options: string[], correctAnswer: string | null | undefined) {
  const original = options.map((option) => clean(option, 240)).filter(Boolean)
  if (!original.length) return { options: [], correctAnswer: null as string | null }
  const correctIndex = Math.max(0, Math.min(original.length - 1, Number(correctAnswer || 0)))
  const pairs = original.map((option, index) => ({ option, correct: index === correctIndex }))
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]] }
  return { options: pairs.map((pair) => pair.option), correctAnswer: String(Math.max(0, pairs.findIndex((pair) => pair.correct))) }
}

function toProgramQuestion(examId: string, order: number, item: any) {
  const type = String(item.type || 'MCQ').toUpperCase()
  const needsReview = item.status !== 'APPROVED' || !hasFlag(item.qualityFlags, 'SOURCE_GROUNDED')
  if (type === 'MCQ') {
    const shuffled = shuffleWithAnswer(parseArray(item.options), item.correctAnswer)
    return { examId, order, type: 'MCQ', text: clean(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: clean(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), sourceEvidence: item.sourceEvidence, sourceBookTitle: item.sourceBookTitle, sourceChapter: null, sourceLocator: item.sourceLocator, cognitiveSkill: item.cognitiveSkill, difficulty: item.difficulty, correctRationale: item.correctRationale, distractorRationales: item.distractorRationales, qualityFlags: item.qualityFlags, reviewNotes: item.reviewNotes, points: 2, status: 'PENDING_REVIEW' }
  }
  if (type === 'TF') {
    const shuffled = shuffleWithAnswer(['صح', 'خطأ'], item.correctAnswer)
    return { examId, order, type: 'TF', text: clean(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: clean(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), sourceEvidence: item.sourceEvidence, sourceBookTitle: item.sourceBookTitle, sourceChapter: null, sourceLocator: item.sourceLocator, cognitiveSkill: item.cognitiveSkill, difficulty: item.difficulty, correctRationale: item.correctRationale, distractorRationales: item.distractorRationales, qualityFlags: item.qualityFlags, reviewNotes: item.reviewNotes, points: 2, status: 'PENDING_REVIEW' }
  }
  return { examId, order, type: type === 'ESSAY' ? 'ESSAY' : 'SHORT', text: clean(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify([]), correctAnswer: null, modelAnswer: clean(item.modelAnswer || item.sourceEvidence, 1800), sourceEvidence: item.sourceEvidence, sourceBookTitle: item.sourceBookTitle, sourceChapter: null, sourceLocator: item.sourceLocator, cognitiveSkill: item.cognitiveSkill, difficulty: item.difficulty, correctRationale: item.correctRationale, distractorRationales: item.distractorRationales, qualityFlags: item.qualityFlags, reviewNotes: item.reviewNotes, points: 2, status: 'PENDING_REVIEW' }
}

function balancedPick(items: any[], count: number) {
  const selected: any[] = []
  const take = (predicate: (item: any) => boolean) => { const found = items.find((item) => predicate(item) && !selected.some((x) => x.id === item.id)); if (found) selected.push(found) }
  take((item) => item.type === 'MCQ')
  take((item) => item.type === 'TF')
  take((item) => item.type === 'SHORT')
  take((item) => item.difficulty === 'EASY')
  take((item) => item.difficulty === 'MEDIUM')
  take((item) => item.difficulty === 'ADVANCED')
  for (const item of items) { if (selected.length >= count) break; if (!selected.some((x) => x.id === item.id)) selected.push(item) }
  return selected.slice(0, count)
}

async function unitsForExam(programId: string, semester: number, comprehensive: boolean) {
  return db.unit.findMany({ where: { programId, ...(comprehensive ? {} : { semester }) }, orderBy: [{ semester: 'asc' }, { order: 'asc' }], select: { id: true, title: true, semester: true } })
}

async function bankForUnits(programId: string, units: { id: string; title: string; semester: number }[], total: number) {
  const perUnit = Math.max(1, Math.ceil(total / Math.max(1, units.length)))
  const selected: any[] = []
  const breakdown: Record<string, { unitTitle: string; selected: number; grounded: number; total: number }> = {}
  const missing: any[] = []
  for (const unit of units) {
    const approved = await db.questionBankItem.findMany({ where: { programId, unitId: unit.id, status: 'APPROVED', qualityFlags: { contains: 'SOURCE_GROUNDED' } }, orderBy: [{ usageCount: 'asc' }, { createdAt: 'desc' }], take: perUnit * 3 })
    const pending = approved.length >= perUnit ? [] : await db.questionBankItem.findMany({ where: { programId, unitId: unit.id, status: 'PENDING_REVIEW', qualityFlags: { contains: 'SOURCE_GROUNDED' } }, orderBy: [{ usageCount: 'asc' }, { createdAt: 'desc' }], take: perUnit * 3 })
    const picked = balancedPick([...approved, ...pending], perUnit)
    selected.push(...picked)
    breakdown[unit.id] = { unitTitle: unit.title, selected: picked.length, grounded: picked.filter((item) => item.status === 'APPROVED' && hasFlag(item.qualityFlags, 'SOURCE_GROUNDED')).length, total: perUnit }
    if (picked.length < perUnit) {
      const job = await ensureQuestionBankGenerationJob({ programId, unitId: unit.id, requested: perUnit - picked.length, startNew: false })
      await runQuestionBankGenerationJobStep(job.id)
      missing.push({ unitId: unit.id, title: unit.title, needed: perUnit - picked.length, jobId: job.id })
    }
  }
  return { selected: balancedPick(selected, total), breakdown, missing }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-program-exam-generate', 8, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const examId = clean(body.examId, 80)
    const comprehensive = body.comprehensive === true || body.semester === 0 || body.semester === 'all'
    const semester = comprehensive ? 0 : Number(body.semester) === 2 ? 2 : 1
    const total = Math.max(10, Math.min(80, Number(body.count || 20)))

    if (body?.action === 'stop' && examId) {
      const exam = await db.programExam.update({ where: { id: examId }, data: { status: 'REVIEW', errorNote: 'تم إيقاف التوليد وإرسال الأسئلة الحالية للمراجعة' } })
      return NextResponse.json({ ok: true, examId: exam.id, status: exam.status })
    }
    if (!programId && !examId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const existing = examId ? await db.programExam.findUnique({ where: { id: examId }, include: { _count: { select: { questions: true, attempts: true } } } }) : null
    const targetProgramId = programId || existing?.programId || ''
    if (!targetProgramId) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (existing?.status === 'READY') return NextResponse.json({ error: 'الامتحان منشور للطلاب — لا يمكن إعادة توليده مباشرة' }, { status: 409 })
    if ((existing as any)?._count?.attempts) return NextResponse.json({ error: 'لا يمكن إعادة توليد امتحان له محاولات طلابية محفوظة' }, { status: 409 })

    const units = await unitsForExam(targetProgramId, existing?.semester || semester || 1, comprehensive)
    if (!units.length) return NextResponse.json({ error: 'لا توجد وحدات لبناء الامتحان. ولّد الوحدات ومحتواها أولاً.' }, { status: 400 })
    const bank = await bankForUnits(targetProgramId, units, total)
    if (bank.missing.length) return NextResponse.json({ ok: false, status: 'PAUSED', error: 'بنك الأسئلة غير كافٍ لبعض الوحدات. تم تشغيل وظائف التوليد لتلك الوحدات؛ أعد المحاولة بعد اكتمالها.', missingUnits: bank.missing, unitBreakdown: bank.breakdown }, { status: 202 })
    if (bank.selected.length < Math.min(10, total)) return NextResponse.json({ error: 'لا توجد أسئلة موثقة كافية في بنك الأسئلة.' }, { status: 409 })

    const program = await db.program.findUnique({ where: { id: targetProgramId }, select: { titleAr: true } })
    const reviewRequired = bank.selected.some((item) => item.status !== 'APPROVED' || !hasFlag(item.qualityFlags, 'SOURCE_GROUNDED'))
    const exam = existing
      ? await db.programExam.update({ where: { id: existing.id }, data: { status: 'REVIEW', errorNote: reviewRequired ? 'يتضمن الامتحان أسئلة تحتاج تدقيقاً من بنك الأسئلة.' : null, totalPoints: 0 } })
      : await db.programExam.create({ data: { programId: targetProgramId, semester: comprehensive ? 3 : semester || 1, title: `${comprehensive ? 'الامتحان الشامل' : `امتحان الفصل ${semester === 2 ? 'الثاني' : 'الأول'}`} — ${program?.titleAr || ''}`, status: 'REVIEW', durationMin: 120, generatedBy: 'AI', errorNote: reviewRequired ? 'يتضمن الامتحان أسئلة تحتاج تدقيقاً من بنك الأسئلة.' : null } })
    await db.programQuestion.deleteMany({ where: { examId: exam.id } })
    await db.programQuestion.createMany({ data: bank.selected.map((item, index) => toProgramQuestion(exam.id, index + 1, item)) })
    const totalPoints = bank.selected.length * 2
    await db.programExam.update({ where: { id: exam.id }, data: { totalPoints, durationMin: Math.max(120, Math.min(240, bank.selected.length * 2)), booksUsed: 'بنك الأسئلة الموثق حسب الوحدات' } })
    await db.questionBankItem.updateMany({ where: { id: { in: bank.selected.map((item) => item.id) } }, data: { usageCount: { increment: 1 } } })
    await audit({ id: admin.id, name: admin.name }, 'GENERATE_PROGRAM_EXAM_FROM_QUESTION_BANK', 'ProgramExam', exam.id, `توليد امتحان من بنك الأسئلة الموثق مع توزيع على ${units.length} وحدة`)
    const grounded = bank.selected.filter((item) => item.status === 'APPROVED' && hasFlag(item.qualityFlags, 'SOURCE_GROUNDED')).length
    return NextResponse.json({ ok: true, examId: exam.id, status: 'REVIEW', inserted: bank.selected.length, requiredQuestions: total, unitBreakdown: bank.breakdown, sourceGroundedRatio: bank.selected.length ? grounded / bank.selected.length : 0, reviewRequired })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-exam generate error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر بدء التوليد' }, { status: 500 })
  }
}
