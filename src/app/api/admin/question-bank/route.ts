import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { getAiGenerationProgress, questionDuplicateKey, resolveGenerationJob, setAiGenerationProgress } from '@/lib/ai-generation-progress'
import { isDuplicateQuestionIdea, selectQuestionKnowledgeSources } from '@/lib/question-bank-diversity'
import { geminiCompleteJson } from '@/lib/gemini'
import { assertQuestionBatchAcceptable, buildQuestionBankRecord, knowledgeEvidenceText, validateQuestionBatchAgainstKnowledge } from '@/lib/question-bank-evidence'
import { setAiTaskPause } from '@/lib/ai-task-pause'
import { audit } from '@/lib/notify'
import { parseGeneratedQuestionCandidates } from '@/lib/question-bank-generation'
import { verifyQuestionsWithCrossProvider } from '@/lib/question-verifier'
import { inferTextProvenance, isEvidenceAllowedByProvenance, textContainsEvidenceAfterNormalization } from '@/lib/text-provenance'

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
  if (correctAnswer != null && Number.isNaN(Number(correctAnswer))) correctAnswer = null
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
    const pauseSetting = await db.setting.findUnique({ where: { key: `AI_TASK_PAUSE:QUESTION_BANK:${programId}` } }).catch(() => null)
    const paused = pauseSetting?.value ? safeJson(pauseSetting.value, null) : null
    const progress = await getAiGenerationProgress('QUESTION_BANK', programId, 'ALL')
    return NextResponse.json({ program, stats: await questionStats(programId), items: await listQuestions(programId, status), paused, progress })
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
    const limited = enforceApiRateLimit(req, 'admin-question-bank', 10, 60 * 1000, admin.id)
    if (limited) return limited
    const requestDeadlineMs = Date.now() + 240_000
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const requestedCount = Math.max(1, Math.min(30, Number(body?.count || 12)))
    const count = Math.min(4, requestedCount)
    const source = cleanText(body?.source, 40) || 'AI'
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, category: true, description: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    const storedProgress = source === 'AI' ? await getAiGenerationProgress('QUESTION_BANK', programId, 'ALL') : null
    const job = resolveGenerationJob(storedProgress, requestedCount, body?.resume === true, body?.startNew === true)
    const requestedTotal = job.requested
    const savedSoFar = job.saved
    const remainingFromProgress = Math.max(0, requestedTotal - savedSoFar)
    const batchCount = Math.min(count, remainingFromProgress || count)

    if (source === 'MANUAL') {
      const result = await insertBankQuestions(programId, [body?.question || body], { generatedBy: 'MANUAL', status: body?.approveNow ? 'APPROVED' : 'PENDING_REVIEW' })
      if (!result.inserted) return NextResponse.json({ error: 'لم يتم حفظ السؤال؛ قد يكون مكررًا أو غير مكتمل', skippedDuplicates: result.skippedDuplicates }, { status: 409 })
      await audit({ id: admin.id, name: admin.name }, 'ADD_QUESTION_BANK_ITEM', 'Program', programId, `إضافة ${result.inserted} سؤال يدوي إلى بنك أسئلة ${program.titleAr}`)
      return NextResponse.json({ ok: true, ...result, stats: await questionStats(programId), items: await listQuestions(programId) })
    }

    if (source === 'REVIEW_LEGACY_GROUNDING') {
      const legacy = await db.questionBankItem.findMany({
        where: { programId, generatedBy: 'AI', qualityFlags: { contains: 'SOURCE_GROUNDED' } },
        select: { id: true },
      })
      if (legacy.length) {
        await db.questionBankItem.updateMany({
          where: { id: { in: legacy.map((item) => item.id) } },
          data: { status: 'PENDING_REVIEW', approvedBy: null, approvedAt: null, qualityFlags: JSON.stringify(['LEGACY_GROUNDING_UNVERIFIED', 'NEEDS_HUMAN_REVIEW']) },
        })
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

    const knowledge = await db.bookKnowledgeItem.findMany({
      where: { programId },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
    })
    if (!knowledge.length) return NextResponse.json({ error: 'لا يوجد بنك معرفة لهذا البرنامج. ابنِ بنك المعرفة من الكتب أولاً.' }, { status: 400 })

    const sourceBooks = await db.book.findMany({
      where: { id: { in: Array.from(new Set(knowledge.map((item) => item.bookId).filter(Boolean) as string[])) } },
      select: { id: true, textContent: true, linkReadNote: true, linkReadStatus: true },
    })
    const bookById = new Map(sourceBooks.map((book) => [book.id, book]))
    const knowledgeTextProvenance = (item: { sourceNote?: string | null; bookId?: string | null; excerpt?: string | null }) => {
      const book = item.bookId ? bookById.get(item.bookId) : null
      return inferTextProvenance({
        sourceNote: item.sourceNote,
        linkReadNote: book?.linkReadNote,
        linkReadStatus: book?.linkReadStatus,
        textContent: book?.textContent,
      })
    }
    const excerptMatchesNativeOrOcrBook = (item: { bookId?: string | null; excerpt?: string | null }) => {
      const excerpt = knowledgeEvidenceText(item).trim()
      if (!excerpt) return false
      const book = item.bookId ? bookById.get(item.bookId) : null
      if (!book?.textContent) return false
      const bookProvenance = inferTextProvenance({ linkReadNote: book.linkReadNote, linkReadStatus: book.linkReadStatus, textContent: book.textContent })
      if (!['NATIVE_TEXT', 'VISION_OCR'].includes(bookProvenance)) return false
      return textContainsEvidenceAfterNormalization(book.textContent, excerpt)
    }
    const evidenceKnowledge = knowledge.filter((item) => {
      const text = knowledgeEvidenceText(item).trim()
      const provenance = knowledgeTextProvenance(item)
      return text.length >= 40 && isEvidenceAllowedByProvenance(provenance) && excerptMatchesNativeOrOcrBook(item)
    })
    if (!evidenceKnowledge.length) return NextResponse.json({ error: 'لا توجد عناصر معرفة تحتوي نص مصدر أصلي كافيًا للاقتباس. أعد تحليل الكتب أولاً.' }, { status: 400 })

    const existing = await db.questionBankItem.findMany({ where: { programId }, select: { text: true, knowledgeItemId: true, bookId: true, sourceLocator: true } })
    const seen = new Set(existing.map((q) => questionDuplicateKey(q.text, q.knowledgeItemId || q.bookId || q.sourceLocator || 'UNKNOWN')))
    const usage = new Map<string, number>()
    for (const item of existing) if (item.knowledgeItemId) usage.set(item.knowledgeItemId, (usage.get(item.knowledgeItemId) || 0) + 1)
    const ideaHistory = existing.map((q) => ({ text: q.text, knowledgeItemId: q.knowledgeItemId }))
    const usedSourceIndexes = [...(job.usedSourceIndexes || [])]
    const knowledgeItemIds = [...(job.knowledgeItemIds || [])]
    const evidenceSources = evidenceKnowledge.map((item) => ({ text: knowledgeEvidenceText(item), textProvenance: knowledgeTextProvenance(item) }))

    let savedTotal = savedSoFar
    let insertedTotal = 0
    let failedBatches = job.failedBatches
    let progress = await setAiGenerationProgress('QUESTION_BANK', programId, 'ALL', job)
    const usagePatch = () => ({ usedSourceIndexes: [...new Set(usedSourceIndexes)], knowledgeItemIds: [...new Set(knowledgeItemIds)] })
    const finishPartial = async (lastError: string | null, status = 200) => {
      if (lastError) failedBatches += 1
      progress = await setAiGenerationProgress('QUESTION_BANK', programId, 'ALL', { jobId: job.jobId, status: savedTotal >= requestedTotal ? 'COMPLETED' : 'PARTIAL', requested: requestedTotal, saved: savedTotal, failedBatches, lastError, ...usagePatch() })
      return NextResponse.json({
        ok: savedTotal > 0,
        inserted: insertedTotal,
        requested: requestedTotal,
        saved: savedTotal,
        remaining: Math.max(0, requestedTotal - savedTotal),
        partial: savedTotal < requestedTotal,
        error: lastError || undefined,
        message: savedTotal < requestedTotal ? `تم حفظ ${savedTotal} من ${requestedTotal}. اضغط مرة أخرى لإكمال الباقي.` : undefined,
        progress,
        stats: await questionStats(programId),
        items: await listQuestions(programId),
      }, { status: savedTotal > 0 ? 200 : status })
    }

    while (savedTotal < requestedTotal) {
      if (Date.now() >= requestDeadlineMs) {
        return finishPartial('AI_REQUEST_DEADLINE_REACHED')
      }
      const currentBatchCount = Math.min(batchCount, requestedTotal - savedTotal)
      const selectedSources = selectQuestionKnowledgeSources(evidenceKnowledge, usage)
      const knowledgeText = selectedSources.map((k) => `${evidenceKnowledge.indexOf(k) + 1}. [${k.category}] ${k.title}\nملخص للسياق فقط: ${String(k.summary || '').slice(0, 650)}\nنص المصدر (اقتبس منه حرفيًا): ${knowledgeEvidenceText(k).slice(0, 1800)}`).join('\n\n')
      const recentIdeas = ideaHistory.slice(-30).map((q) => q.text.slice(0, 60)).join(' | ')
      let generated: any[] = []
      let generationContext: { provider?: string; model?: string } = {}
      try {
        const raw = await geminiCompleteJson({
          system: 'أنت مصمم أسئلة جامعية. أرجع JSON صالحاً فقط دون أي شرح خارج JSON.',
          history: [{ role: 'user', text: `
أنشئ ${currentBatchCount} سؤالاً لبنك أسئلة مركزي لبرنامج: ${program.titleAr}
التصنيف: ${program.category}
الوصف: ${program.description || 'غير محدد'}

اعتمد فقط على عناصر بنك المعرفة التالية:
${knowledgeText}

مواضيع آخر الأسئلة المحفوظة: ${recentIdeas || 'لا توجد'}
لا تكرر هذه الأفكار ولو بصياغة مختلفة.

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
      "sourceIndex": 1,
      "correctRationale": "سبب صحة الإجابة",
      "distractorRationales": ["سبب خطأ الخيار 1"]
    }
  ]
}

القواعد:
- وزّع الأنواع افتراضياً: 60% MCQ و20% TF و20% SHORT/ESSAY، ما لم يحدد الأدمن توزيعاً آخر.
- أمثلة الحقول لكل نوع (احتفظ أيضاً بـ sourceEvidence الحرفي وsourceIndex وtext وdifficulty لكل سؤال):
  MCQ: {"type":"MCQ","text":"ما الفكرة الأساسية المذكورة في النص؟","options":["الأول","الثاني","الثالث","الرابع"],"correctAnswer":"الأول","sourceEvidence":"اقتباس حرفي من المصدر","sourceIndex":1,"difficulty":"MEDIUM","correctRationale":"لأن النص يؤيد الاختيار الأول"}.
  TF: {"type":"TF","text":"هل تؤكد العبارة الفكرة الواردة في النص؟","options":["صح","خطأ"],"correctAnswer":"صح","sourceEvidence":"اقتباس حرفي من المصدر","sourceIndex":1,"difficulty":"MEDIUM"}.
  SHORT/ESSAY: {"type":"ESSAY","text":"حلل الفكرة كما وردت في النص بالتفصيل.","options":[],"modelAnswer":"إجابة نموذجية مفصلة لا تقل عن أربعين حرفاً، تستند مباشرة إلى النص المقتبس وتشرح الفكرة وأسبابها.","sourceEvidence":"اقتباس حرفي من المصدر","sourceIndex":1,"difficulty":"MEDIUM"}. في SHORT/ESSAY لا يلزم correctAnswer ولا distractorRationales، ويلزم modelAnswer بطول 40 حرفاً على الأقل.
- لا تكرر سؤالاً بنفس المعنى.
- للأسئلة SHORT/ESSAY: ابنِ modelAnswer فقط من sourceEvidence والنص الحرفي للمصدر نفسه، دون معلومات إضافية أو استنتاجات تتجاوز ما يقوله المصدر.
- إن لم يكفِ نص المصدر لإجابة قصيرة أو مقالية موثوقة، ولّد MCQ أو TF بدلاً منها.
- كل سؤال يجب أن يكون مرتبطاً بدليل من بنك المعرفة.
- sourceEvidence يجب أن يكون اقتباساً حرفياً من "نص المصدر" للعنصر المحدد، وليس من الملخص.
- لكل سؤال أعد sourceIndex وهو رقم عنصر المعرفة المستخدم فعلياً (1 يبدأ من أول عنصر في قائمة المعرفة أعلاه)، ولا تختر عنصراً لا يدعم السؤال مباشرة.
- اجعل الإجابة الصحيحة واضحة وقابلة للمراجعة.
- الأسئلة ستبقى بانتظار مراجعة الإدارة.` }],
          temperature: 0.25,
          thinkingBudget: 256,
          maxOutputTokens: 6000,
          taskLevel: 'ACADEMIC_CRITICAL',
          stickyScope: `QUESTION_BANK:${programId}`,
          deadlineMs: requestDeadlineMs,
          validate: (text, context) => {
            const candidates = parseGeneratedQuestionCandidates(text)
            generationContext = context || {}
            if (!candidates.accepted.length) {
              const err: any = new Error('EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION')
              err.code = 'VALIDATION_REJECTED'
              throw err
            }
            const validation = validateQuestionBatchAgainstKnowledge(candidates.accepted, evidenceSources, context)
            for (const rejection of validation.rejected) {
              const q = candidates.accepted[rejection.index]
              console.warn(`question bank evidence rejected index=${rejection.index} type=${String(q?.type || 'UNKNOWN')} sourceIndex=${rejection.sourceIndex} reason=${rejection.reason} question="${String(q?.text || '').slice(0, 80)}"`)
            }
            assertQuestionBatchAcceptable(candidates.accepted.length + candidates.rejected, validation.rejected.length + candidates.rejected)
          },
        })
        generated = parseGeneratedQuestionCandidates(raw).accepted
      } catch (e: any) {
        console.error('question bank AI failed:', e)
        const reason = String(e?.message || e).slice(0, 500)
        const paused = { code: e?.code || 'AI_ACADEMIC_PROVIDER_UNAVAILABLE', reason, retryAt: e?.retryAt || null, pausedAt: new Date().toISOString() }
        await setAiTaskPause('QUESTION_BANK', programId, paused).catch(() => paused)
        return finishPartial(reason, 503)
      }

      if (!generated.length) return finishPartial('لم يُرجع المزود أسئلة أكاديمية صالحة.', 503)

      const finalValidation = validateQuestionBatchAgainstKnowledge(generated, evidenceSources)
      for (const rejection of finalValidation.rejected) {
        const q = generated[rejection.index]
        console.warn(`question bank evidence rejected before save index=${rejection.index} type=${String(q?.type || 'UNKNOWN')} sourceIndex=${rejection.sourceIndex} reason=${rejection.reason} question="${String(q?.text || '').slice(0, 80)}"`)
      }
      const verifiedQuestions = await verifyQuestionsWithCrossProvider({
        questions: finalValidation.accepted,
        sources: evidenceSources,
        generatorProvider: generationContext.provider,
        generatorModel: generationContext.model,
      })

      const rows: any[] = []
      for (let i = 0; i < verifiedQuestions.length; i++) {
        const item = verifiedQuestions[i]
        const requestedSourceIndex = Number(item.sourceIndex)
        const source = Number.isInteger(requestedSourceIndex) && requestedSourceIndex >= 1 && requestedSourceIndex <= evidenceKnowledge.length
          ? evidenceKnowledge[requestedSourceIndex - 1]
          : null
        if (!source || !selectedSources.some((selected) => selected.id === source.id)) continue
        if ((usage.get(source.id) || 0) >= 2 && evidenceKnowledge.some((other) => (usage.get(other.id) || 0) < 2)) continue
        const q = {
          ...sanitizeQuestion(item, { title: source.title, summary: source.summary, sourceBookTitle: source.sourceNote }),
          qualityFlags: item.qualityFlags,
          verifierProvider: item.verifierProvider,
          verifierModel: item.verifierModel,
          verifiedAt: item.verifiedAt,
          verifierReason: item.verifierReason,
          verificationPending: item.verificationPending,
          verificationReason: item.verificationReason,
          textProvenance: item.textProvenance,
        }
        if (!q.text || q.text.length < 12) continue
        const sourceRef = source.id || source.bookId || q.sourceLocator || 'UNKNOWN'
        const key = questionDuplicateKey(q.text, sourceRef)
        if (seen.has(key)) continue
        if (isDuplicateQuestionIdea(q.text, source.id, ideaHistory)) {
          console.warn(`question bank evidence rejected index=${i} type=${q.type} sourceIndex=${requestedSourceIndex} reason=DUPLICATE_IDEA question="${q.text.slice(0, 80)}"`)
          continue
        }
        seen.add(key)
        ideaHistory.push({ text: q.text, knowledgeItemId: source.id })
        usage.set(source.id, (usage.get(source.id) || 0) + 1)
        usedSourceIndexes.push(requestedSourceIndex)
        knowledgeItemIds.push(source.id)
        rows.push(buildQuestionBankRecord(q, {
          programId,
          knowledgeItemId: source.id,
          bookId: source.bookId || null,
          semester: source.semester || null,
          provider: generationContext.provider,
          model: generationContext.model,
        }))
        if (rows.length >= currentBatchCount) break
      }

      if (!rows.length) return finishPartial('لم يتم توليد أسئلة جديدة غير مكررة.', 409)
      await db.questionBankItem.createMany({ data: rows })
      insertedTotal += rows.length
      savedTotal += rows.length
      progress = await setAiGenerationProgress('QUESTION_BANK', programId, 'ALL', { jobId: job.jobId, status: savedTotal >= requestedTotal ? 'COMPLETED' : 'RUNNING', requested: requestedTotal, saved: savedTotal, failedBatches, lastError: null, ...usagePatch() })
      if (Date.now() >= requestDeadlineMs && savedTotal < requestedTotal) return finishPartial('AI_REQUEST_DEADLINE_REACHED')
    }

    await db.setting.deleteMany({ where: { key: `AI_TASK_PAUSE:QUESTION_BANK:${programId}` } }).catch(() => {})
    await audit({ id: admin.id, name: admin.name }, 'GENERATE_QUESTION_BANK', 'Program', programId, `توليد ${insertedTotal} سؤال لبنك أسئلة ${program.titleAr} من بنك المعرفة`)
    return NextResponse.json({
      ok: true,
      inserted: insertedTotal,
      requested: requestedTotal,
      saved: savedTotal,
      remaining: 0,
      partial: false,
      progress,
      stats: await questionStats(programId),
      items: await listQuestions(programId),
    })
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
    await audit({ id: admin.id, name: admin.name }, 'REVIEW_QUESTION_BANK_ITEM', 'QuestionBankItem', id, `تحديث سؤال بنك الأسئلة إلى الحالة ${item.status}`)
    return NextResponse.json({ ok: true, item })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث سؤال بنك الأسئلة' }, { status: 500 })
  }
}
