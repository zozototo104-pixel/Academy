import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { getAiGenerationProgress } from '@/lib/ai-generation-progress'
import { audit } from '@/lib/notify'
import { ensureQuestionBankGenerationJob, runNextQuestionBankGenerationJobStep, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const maxDuration = 300

const STATUSES = new Set(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED'])
const TYPES = new Set(['MCQ', 'TF', 'SHORT', 'ESSAY'])
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safeJson(value: unknown, fallback: any = null) {
  try {
    if (typeof value === 'string') return JSON.parse(value)
    return value ?? fallback
  } catch (error) {
    console.warn('Failed to parse question bank JSON value; using fallback.', error)
    return fallback
  }
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

function safeOptions(value: unknown, type: string) {
  const arr = Array.isArray(value) ? value : []
  const options = arr.map((x) => cleanText(x, 260)).filter(Boolean).slice(0, 6)
  if (type === 'TF') return ['صح', 'خطأ']
  if (type === 'MCQ') return options.length >= 3 ? options.slice(0, 4) : ['خيار أول', 'خيار ثانٍ', 'خيار ثالث', 'خيار رابع']
  return []
}

function parseImportedQuestions(value: unknown) {
  if (Array.isArray(value)) return value
  const text = String(value || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.questions)) return parsed.questions
  } catch (error) {
    console.warn('Failed to parse imported questions JSON; falling back to delimited rows.', error)
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const hasHeader = Boolean(lines[0] && /type|question|text|السؤال|النوع/i.test(lines[0]))
  const rows = (hasHeader ? lines.slice(1) : lines).map((line) => line.split(/\t|,/).map((x) => x.trim()))
  return rows.map((cols) => ({
    type: cols[0] || 'MCQ',
    text: cols[1] || cols[0],
    options: [cols[2], cols[3], cols[4], cols[5]].filter(Boolean),
    correctAnswer: cols[6] || '0',
    modelAnswer: cols[7] || '',
    difficulty: cols[8] || 'MEDIUM',
    sourceEvidence: cols[9] || '',
  })).filter((q) => cleanText(q.text, 1200).length > 8)
}

function sanitizeQuestion(raw: any, fallback: any = {}) {
  const type = TYPES.has(String(raw?.type || '').toUpperCase()) ? String(raw.type).toUpperCase() : 'MCQ'
  const difficulty = DIFFICULTIES.has(String(raw?.difficulty || '').toUpperCase()) ? String(raw.difficulty).toUpperCase() : 'MEDIUM'
  const text = cleanText(raw?.text || raw?.question || fallback.title, 1200)
  const options = safeOptions(raw?.options, type)
  let correctAnswer = raw?.correctAnswer != null ? String(raw.correctAnswer) : null
  if (correctAnswer != null && Number.isNaN(Number(correctAnswer))) {
    const index = options.findIndex((option) => option === correctAnswer)
    correctAnswer = index >= 0 ? String(index) : null
  }
  if (type === 'MCQ' && correctAnswer != null) correctAnswer = String(Math.max(0, Math.min(options.length - 1, Number(correctAnswer))))
  if (type === 'TF' && correctAnswer != null) correctAnswer = ['0', '1'].includes(correctAnswer) ? correctAnswer : null
  return {
    type,
    text,
    options: options.length ? JSON.stringify(options) : null,
    correctAnswer: type === 'MCQ' || type === 'TF' ? correctAnswer : null,
    modelAnswer: type === 'SHORT' || type === 'ESSAY' ? cleanText(raw?.modelAnswer || raw?.answer || fallback.summary, 1800) : cleanText(raw?.modelAnswer || '', 1200) || null,
    sourceEvidence: cleanText(raw?.sourceEvidence || fallback.summary, 1800) || null,
    sourceBookTitle: cleanText(raw?.sourceBookTitle || fallback.sourceBookTitle, 220) || null,
    sourceLocator: cleanText(raw?.sourceLocator || fallback.title, 220) || null,
    cognitiveSkill: cleanText(raw?.cognitiveSkill || 'UNDERSTAND', 40) || 'UNDERSTAND',
    difficulty,
    correctRationale: cleanText(raw?.correctRationale || raw?.rationale, 1000) || null,
    distractorRationales: raw?.distractorRationales ? JSON.stringify(raw.distractorRationales).slice(0, 1800) : null,
    qualityFlags: JSON.stringify(['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW']),
  }
}

async function insertBankQuestions(programId: string, questions: any[], meta: { generatedBy: string; status?: string; fallback?: any }) {
  const existing = await db.questionBankItem.findMany({ where: { programId }, select: { text: true } })
  const seen = new Set(existing.map((q) => norm(q.text)))
  const rows: any[] = []
  let skippedDuplicates = 0
  for (const raw of questions) {
    const q = sanitizeQuestion(raw, meta.fallback || {})
    if (!q.text || q.text.length < 12) continue
    const key = norm(q.text)
    if (seen.has(key)) {
      skippedDuplicates++
      continue
    }
    seen.add(key)
    rows.push({ programId, ...q, status: meta.status || 'PENDING_REVIEW', generatedBy: meta.generatedBy, qualityFlags: q.qualityFlags || JSON.stringify(['NEEDS_HUMAN_REVIEW']) })
  }
  if (rows.length > 0) await db.questionBankItem.createMany({ data: rows })
  return { inserted: rows.length, skippedDuplicates }
}

async function questionStats(programId: string) {
  const rows = await db.questionBankItem.findMany({ where: { programId }, select: { status: true, difficulty: true, type: true } })
  return {
    total: rows.length,
    pending: rows.filter((x) => x.status === 'PENDING_REVIEW').length,
    approved: rows.filter((x) => x.status === 'APPROVED').length,
    rejected: rows.filter((x) => x.status === 'REJECTED').length,
    byDifficulty: { EASY: rows.filter((x) => x.difficulty === 'EASY').length, MEDIUM: rows.filter((x) => x.difficulty === 'MEDIUM').length, ADVANCED: rows.filter((x) => x.difficulty === 'ADVANCED').length },
    byType: { MCQ: rows.filter((x) => x.type === 'MCQ').length, TF: rows.filter((x) => x.type === 'TF').length, SHORT: rows.filter((x) => x.type === 'SHORT').length, ESSAY: rows.filter((x) => x.type === 'ESSAY').length },
  }
}

async function listQuestions(programId: string, status?: string | null) {
  const items = await db.questionBankItem.findMany({
    where: { programId, ...(status && STATUSES.has(status) ? { status } : {}) },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 120,
  })
  return items.map((item) => ({ ...item, verifierReason: item.reviewNotes || null }))
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    const status = cleanText(req.nextUrl.searchParams.get('status'), 40)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    await runNextQuestionBankGenerationJobStep(programId).catch((error) => console.warn('question bank background resume failed:', error))
    const pauseSetting = await db.setting.findUnique({ where: { key: `AI_TASK_PAUSE:QUESTION_BANK:${programId}` } }).catch(() => null)
    const paused = pauseSetting?.value ? safeJson(pauseSetting.value, null) : null
    const progress = await getAiGenerationProgress('QUESTION_BANK', programId, 'ALL')
    const jobs = await db.questionBankGenerationJob.findMany({ where: { programId }, orderBy: { createdAt: 'desc' }, take: 5 })
    return NextResponse.json({ program, stats: await questionStats(programId), items: await listQuestions(programId, status), paused, progress, jobs })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل بنك الأسئلة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-question-bank', 10, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const source = cleanText(body?.source, 40) || 'AI'
    const requestedTotal = Math.max(1, Math.min(60, Number(body?.count || 12)))
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    if (source === 'MANUAL') {
      const result = await insertBankQuestions(programId, [body?.question || body], { generatedBy: 'MANUAL', status: body?.approveNow ? 'APPROVED' : 'PENDING_REVIEW' })
      if (!result.inserted) return NextResponse.json({ error: 'لم يتم حفظ السؤال؛ قد يكون مكررًا أو غير مكتمل', skippedDuplicates: result.skippedDuplicates }, { status: 409 })
      await audit({ id: admin.id, name: admin.name }, 'ADD_QUESTION_BANK_ITEM', 'Program', programId, `إضافة ${result.inserted} سؤال يدوي إلى بنك أسئلة ${program.titleAr}`)
      return NextResponse.json({ ok: true, ...result, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    if (source === 'REVIEW_LEGACY_GROUNDING') {
      const legacy = await db.questionBankItem.findMany({ where: { programId, generatedBy: 'AI', qualityFlags: { contains: 'SOURCE_GROUNDED' } }, select: { id: true } })
      if (legacy.length) {
        await db.questionBankItem.updateMany({ where: { id: { in: legacy.map((item) => item.id) } }, data: { status: 'PENDING_REVIEW', approvedBy: null, approvedAt: null, qualityFlags: JSON.stringify(['LEGACY_GROUNDING_UNVERIFIED', 'NEEDS_HUMAN_REVIEW']) } })
      }
      await audit({ id: admin.id, name: admin.name }, 'REVIEW_LEGACY_QUESTION_GROUNDING', 'Program', programId, `إعادة ${legacy.length} سؤال AI قديم إلى المراجعة دون حذف`)
      return NextResponse.json({ ok: true, marked: legacy.length, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    if (source === 'IMPORT') {
      const imported = parseImportedQuestions(body?.questions || body?.text || body?.csv)
      const result = await insertBankQuestions(programId, imported, { generatedBy: 'IMPORT', status: body?.approveNow ? 'APPROVED' : 'PENDING_REVIEW' })
      if (!result.inserted) return NextResponse.json({ error: 'لم يتم استيراد أسئلة جديدة؛ تحقق من التنسيق أو التكرار', skippedDuplicates: result.skippedDuplicates }, { status: 409 })
      await audit({ id: admin.id, name: admin.name }, 'IMPORT_QUESTION_BANK', 'Program', programId, `استيراد ${result.inserted} سؤال إلى بنك أسئلة ${program.titleAr} وتجاوز ${result.skippedDuplicates} مكرر`)
      return NextResponse.json({ ok: true, ...result, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    const unitId = cleanText(body?.unitId, 80) || null
    const backgroundJob = await ensureQuestionBankGenerationJob({ programId, unitId, requested: requestedTotal, startNew: body?.startNew === true })
    const beforeSaved = backgroundJob.saved
    const stepped = await runQuestionBankGenerationJobStep(backgroundJob.id)
    const current = stepped || backgroundJob
    await audit({ id: admin.id, name: admin.name }, 'QUEUE_QUESTION_BANK_JOB', unitId ? 'Unit' : 'Program', unitId || programId, `تشغيل وظيفة بنك الأسئلة ${backgroundJob.id} للنطاق ${unitId ? 'وحدة' : 'برنامج'} من ${program.titleAr}`)
    return NextResponse.json({
      ok: ['COMPLETED', 'QUEUED', 'RUNNING'].includes(current.status),
      job: current,
      inserted: Math.max(0, Number(current.saved || 0) - Number(beforeSaved || 0)),
      requested: current.requested,
      saved: current.saved,
      remaining: Math.max(0, Number(current.requested || 0) - Number(current.saved || 0)),
      partial: Number(current.saved || 0) < Number(current.requested || 0),
      paused: current.status === 'PAUSED',
      error: current.lastError || undefined,
      message: current.status === 'PAUSED' ? 'توقفت وظيفة بنك الأسئلة مؤقتاً لعدم توفر مزود أكاديمي. ستُستكمل من cron أو عند فتح الصفحة.' : undefined,
      stats: await questionStats(programId),
      items: await listQuestions(programId),
    }, { status: current.status === 'PAUSED' ? 503 : 200 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank POST error:', e)
    return NextResponse.json({ error: 'تعذر توليد أسئلة بنك الأسئلة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const id = cleanText(body?.id, 80)
    if (!id) return NextResponse.json({ error: 'معرف السؤال مطلوب' }, { status: 400 })
    const data: any = {}
    if (body?.status !== undefined) {
      const status = cleanText(body.status, 40)
      if (!STATUSES.has(status)) return NextResponse.json({ error: 'حالة السؤال غير صحيحة' }, { status: 400 })
      data.status = status
      if (status === 'APPROVED') { data.approvedBy = admin.id; data.approvedAt = new Date(); data.rejectedReason = null }
      if (status === 'REJECTED') { data.approvedBy = null; data.approvedAt = null; data.rejectedReason = cleanText(body?.rejectedReason, 500) || 'رفضته الإدارة أثناء المراجعة' }
    }
    for (const field of ['text', 'modelAnswer', 'sourceEvidence', 'sourceBookTitle', 'sourceLocator', 'cognitiveSkill', 'difficulty', 'correctRationale', 'reviewNotes']) {
      if (body?.[field] !== undefined) data[field] = cleanText(body[field], field === 'text' ? 1200 : 1800) || null
    }
    if (body?.type !== undefined) {
      const type = cleanText(body.type, 20)
      if (TYPES.has(type)) data.type = type
    }
    if (body?.options !== undefined) data.options = JSON.stringify(safeOptions(body.options, data.type || 'MCQ'))
    if (body?.correctAnswer !== undefined) data.correctAnswer = cleanText(body.correctAnswer, 20)
    const item = await db.questionBankItem.update({ where: { id }, data })
    await audit({ id: admin.id, name: admin.name }, 'REVIEW_QUESTION_BANK_ITEM', 'QuestionBankItem', id, `تحديث سؤال بنك الأسئلة إلى الحالة ${item.status}`)
    return NextResponse.json({ ok: true, item })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث سؤال بنك الأسئلة' }, { status: 500 })
  }
}
