import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { geminiCompleteJson } from '@/lib/gemini'
import { audit } from '@/lib/notify'

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
  } catch {
    return fallback
  }
}

function parseJsonObject(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON')
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
  } catch {}

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const hasHeader = /type|question|text|السؤال|النوع/i.test(lines[0])
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
    rows.push({
      programId,
      ...q,
      status: meta.status || 'PENDING_REVIEW',
      generatedBy: meta.generatedBy,
      qualityFlags: q.qualityFlags || JSON.stringify(['NEEDS_HUMAN_REVIEW']),
    })
  }
  if (rows.length > 0) await db.questionBankItem.createMany({ data: rows })
  return { inserted: rows.length, skippedDuplicates }
}

function sanitizeQuestion(raw: any, fallback: any = {}) {
  const type = TYPES.has(String(raw?.type || '').toUpperCase()) ? String(raw.type).toUpperCase() : 'MCQ'
  const difficulty = DIFFICULTIES.has(String(raw?.difficulty || '').toUpperCase()) ? String(raw.difficulty).toUpperCase() : 'MEDIUM'
  const text = cleanText(raw?.text || raw?.question || fallback.title, 1200)
  const options = safeOptions(raw?.options, type)
  let correctAnswer = raw?.correctAnswer != null ? String(raw.correctAnswer) : null
  if ((type === 'MCQ' || type === 'TF') && (correctAnswer == null || Number.isNaN(Number(correctAnswer)))) correctAnswer = '0'
  if (type === 'MCQ') correctAnswer = String(Math.max(0, Math.min(options.length - 1, Number(correctAnswer || 0))))
  if (type === 'TF') correctAnswer = String(Number(correctAnswer || 0) === 1 ? 1 : 0)
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
    qualityFlags: JSON.stringify(['SOURCE_GROUNDED', 'NEEDS_HUMAN_REVIEW']),
  }
}

async function questionStats(programId: string) {
  const rows = await db.questionBankItem.findMany({
    where: { programId },
    select: { status: true, difficulty: true, type: true },
  })
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

async function listQuestions(programId: string, status?: string | null) {
  return db.questionBankItem.findMany({
    where: { programId, ...(status && STATUSES.has(status) ? { status } : {}) },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 120,
  })
}

// GET /api/admin/question-bank?programId=...&status=PENDING_REVIEW
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    const status = cleanText(req.nextUrl.searchParams.get('status'), 40)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    return NextResponse.json({ program, stats: await questionStats(programId), items: await listQuestions(programId, status) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل بنك الأسئلة' }, { status: 500 })
  }
}

// POST /api/admin/question-bank — توليد أسئلة من بنك المعرفة إلى بنك الأسئلة المركزي
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const count = Math.max(4, Math.min(30, Number(body?.count || 12)))
    const source = cleanText(body?.source, 40) || 'AI'
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, category: true, description: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    if (source === 'MANUAL') {
      const result = await insertBankQuestions(programId, [body?.question || body], { generatedBy: 'MANUAL', status: body?.approveNow ? 'APPROVED' : 'PENDING_REVIEW' })
      if (!result.inserted) return NextResponse.json({ error: 'لم يتم حفظ السؤال؛ قد يكون مكررًا أو غير مكتمل', skippedDuplicates: result.skippedDuplicates }, { status: 409 })
      await audit({ id: admin.id, name: admin.name }, 'ADD_QUESTION_BANK_ITEM', 'Program', programId, `إضافة ${result.inserted} سؤال يدوي إلى بنك أسئلة ${program.titleAr}`)
      return NextResponse.json({ ok: true, ...result, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    if (source === 'IMPORT') {
      const imported = parseImportedQuestions(body?.questions || body?.text || body?.csv)
      const result = await insertBankQuestions(programId, imported, { generatedBy: 'IMPORT', status: body?.approveNow ? 'APPROVED' : 'PENDING_REVIEW' })
      if (!result.inserted) return NextResponse.json({ error: 'لم يتم استيراد أسئلة جديدة؛ تحقق من التنسيق أو التكرار', skippedDuplicates: result.skippedDuplicates }, { status: 409 })
      return NextResponse.json({ ok: true, ...result, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    const knowledge = await db.bookKnowledgeItem.findMany({
      where: { programId },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
    })
    if (!knowledge.length) return NextResponse.json({ error: 'لا يوجد بنك معرفة لهذا البرنامج. ابنِ بنك المعرفة من الكتب أولاً.' }, { status: 400 })

    const existing = await db.questionBankItem.findMany({ where: { programId }, select: { text: true } })
    const seen = new Set(existing.map((q) => norm(q.text)))
    const knowledgeText = knowledge.map((k, i) => `${i + 1}. [${k.category}] ${k.title}\n${String(k.summary || '').slice(0, 650)}\nدليل: ${String(k.excerpt || k.sourceNote || '').slice(0, 360)}`).join('\n\n')

    let generated: any[] = []
    try {
      const raw = await geminiCompleteJson({
        system: 'أنت مصمم أسئلة جامعية. أرجع JSON صالحاً فقط دون أي شرح خارج JSON.',
        history: [{ role: 'user', text: `
أنشئ ${count} سؤالاً لبنك أسئلة مركزي لبرنامج: ${program.titleAr}
التصنيف: ${program.category}
الوصف: ${program.description || 'غير محدد'}

اعتمد فقط على عناصر بنك المعرفة التالية:
${knowledgeText}

أرجع JSON بالشكل:
{
  "questions": [
    {
      "type": "MCQ | TF | SHORT | ESSAY",
      "text": "نص السؤال",
      "options": ["..."],
      "correctAnswer": "0",
      "modelAnswer": "إجابة نموذجية للأسئلة القصيرة/المقالية",
      "sourceEvidence": "دليل من بنك المعرفة",
      "sourceBookTitle": "اسم المرجع إن ظهر",
      "sourceLocator": "عنوان العنصر أو المحور",
      "cognitiveSkill": "UNDERSTAND | APPLY | ANALYZE | EVALUATE",
      "difficulty": "EASY | MEDIUM | ADVANCED",
      "correctRationale": "سبب صحة الإجابة",
      "distractorRationales": ["سبب خطأ الخيار 1"]
    }
  ]
}

القواعد:
- اجعل 60% اختيار متعدد أو صح/خطأ، و40% قصيرة/مقالية.
- لا تكرر سؤالاً بنفس المعنى.
- كل سؤال يجب أن يكون مرتبطاً بدليل من بنك المعرفة.
- اجعل الإجابة الصحيحة واضحة وقابلة للمراجعة.
- الأسئلة ستبقى بانتظار مراجعة الإدارة.` }],
        temperature: 0.25,
        thinkingBudget: 256,
        maxOutputTokens: 6000,
      })
      const parsed = parseJsonObject(raw)
      generated = Array.isArray(parsed?.questions) ? parsed.questions : []
    } catch (e) {
      console.error('question bank AI failed:', e)
    }

    if (!generated.length) {
      generated = knowledge.slice(0, count).map((k, i) => ({
        type: i % 3 === 0 ? 'SHORT' : 'MCQ',
        text: `اشرح بإيجاز: ${k.title}`,
        options: [`${k.title}`, 'خيار غير مرتبط', 'مصطلح عام', 'لا شيء مما سبق'],
        correctAnswer: '0',
        modelAnswer: k.summary,
        sourceEvidence: k.summary,
        sourceLocator: k.title,
        difficulty: i % 4 === 0 ? 'ADVANCED' : 'MEDIUM',
        cognitiveSkill: i % 4 === 0 ? 'ANALYZE' : 'UNDERSTAND',
        correctRationale: 'الإجابة مستندة إلى عنصر بنك المعرفة المحدد.',
      }))
    }

    const rows: any[] = []
    for (let i = 0; i < generated.length; i++) {
      const source = knowledge[i % knowledge.length]
      const q = sanitizeQuestion(generated[i], { title: source.title, summary: source.summary, sourceBookTitle: source.sourceNote })
      if (!q.text || q.text.length < 12) continue
      const key = norm(q.text)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        programId,
        knowledgeItemId: source.id,
        bookId: source.bookId || null,
        semester: source.semester || null,
        ...q,
        status: 'PENDING_REVIEW',
        generatedBy: 'AI',
      })
      if (rows.length >= count) break
    }

    if (!rows.length) return NextResponse.json({ error: 'لم يتم توليد أسئلة جديدة غير مكررة.' }, { status: 409 })
    await db.questionBankItem.createMany({ data: rows })
    return NextResponse.json({ ok: true, inserted: rows.length, stats: await questionStats(programId), items: await listQuestions(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank POST error:', e)
    return NextResponse.json({ error: 'تعذر توليد أسئلة بنك الأسئلة' }, { status: 500 })
  }
}

// PATCH /api/admin/question-bank — مراجعة/اعتماد/رفض السؤال المركزي
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
    return NextResponse.json({ ok: true, item })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث سؤال بنك الأسئلة' }, { status: 500 })
  }
}
