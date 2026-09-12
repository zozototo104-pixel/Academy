import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { fallbackExamQuestionBatch, generateExamQuestionBatch, EXAM_BATCH_COUNT, EXAM_BATCH_SPECS, type ExamSourceBook, type GeneratedQuestion } from '@/lib/books-ai'
import { hydrateBookContentForExam } from '@/lib/book-content'
import { buildKnowledgeContextForExam } from '@/lib/knowledge-bank'

export const runtime = 'nodejs'
export const maxDuration = 300

function totalRequiredQuestions(): number {
  return EXAM_BATCH_SPECS.reduce((sum, b) => sum + b.count, 0)
}

function firstMissingBatchIndex(existingCount: number): number {
  let cumulative = 0
  for (let i = 0; i < EXAM_BATCH_SPECS.length; i++) {
    cumulative += EXAM_BATCH_SPECS[i].count
    if (existingCount < cumulative) return i
  }
  return EXAM_BATCH_COUNT
}

async function isExamStillGenerating(examId: string): Promise<boolean> {
  const row = await db.programExam.findUnique({ where: { id: examId }, select: { status: true } })
  return row?.status === 'GENERATING'
}

async function stopGenerationAndExposeReview(examId: string, admin: { id: string; name: string }) {
  const exam = await db.programExam.findUnique({
    where: { id: examId },
    include: { program: { select: { titleAr: true } } },
  })
  if (!exam) return { error: 'الامتحان غير موجود', statusCode: 404 }
  if (exam.status === 'READY') return { error: 'الامتحان منشور بالفعل ولا يمكن إيقاف توليده', statusCode: 409 }

  const questions = await db.programQuestion.findMany({ where: { examId }, select: { points: true } })
  const questionCount = questions.length
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)
  const nextStatus = questionCount > 0 ? 'REVIEW' : 'FAILED'
  const errorNote = questionCount > 0
    ? `تم إيقاف التوليد يدوياً بعد حفظ ${questionCount} سؤالاً — الأسئلة جاهزة للمراجعة والتعديل قبل النشر`
    : 'تم إيقاف التوليد يدوياً قبل توليد أي سؤال'

  await db.programExam.update({
    where: { id: examId },
    data: {
      status: nextStatus,
      errorNote,
      totalPoints,
      durationMin: questionCount > 0 ? Math.max(120, Math.min(240, Math.round(questionCount * 2))) : exam.durationMin,
    },
  })

  await audit(
    { id: admin.id, name: admin.name },
    'STOP_PROGRAM_EXAM_GENERATION',
    'ProgramExam',
    examId,
    `إيقاف توليد امتحان ${exam.program.titleAr} بعد ${questionCount} سؤال`
  )

  return { ok: true, examId, status: nextStatus, questionCount, totalPoints }
}

function normalizeQuestionText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

async function examTotals(examId: string): Promise<{ questionCount: number; totalPoints: number }> {
  const rows = await db.programQuestion.findMany({ where: { examId }, select: { points: true } })
  return { questionCount: rows.length, totalPoints: rows.reduce((sum, q) => sum + q.points, 0) }
}

async function existingQuestionKeys(examId: string): Promise<Set<string>> {
  const rows = await db.programQuestion.findMany({ where: { examId }, select: { text: true } })
  return new Set(rows.map((q) => normalizeQuestionText(q.text).slice(0, 160)).filter(Boolean))
}

function optionSignatureFromJson(options: string | null): string {
  if (!options) return ''
  try {
    const arr = JSON.parse(options)
    return Array.isArray(arr) ? arr.map((o) => normalizeQuestionText(o)).filter(Boolean).join('|') : ''
  } catch {
    return ''
  }
}

function optionSignatureFromArray(options?: string[] | null): string {
  return Array.isArray(options) ? options.map((o) => normalizeQuestionText(o)).filter(Boolean).join('|') : ''
}

function stringifyJsonField(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value) && value.length === 0) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function createProgramQuestionData(examId: string, order: number, q: GeneratedQuestion) {
  return {
    examId,
    order,
    type: q.type,
    text: q.text,
    options: q.options ? JSON.stringify(q.options) : null,
    correctAnswer: q.correct ?? null,
    modelAnswer: q.modelAnswer ?? (q.bookEvidence ? `مرجع التصحيح: ${q.bookEvidence}` : null),
    sourceEvidence: q.bookEvidence || null,
    sourceBookTitle: q.sourceBookTitle || null,
    sourceChapter: q.sourceChapter || null,
    sourceLocator: q.sourceLocator || null,
    cognitiveSkill: q.cognitiveSkill || null,
    difficulty: q.difficulty || null,
    correctRationale: q.correctRationale || null,
    distractorRationales: stringifyJsonField(q.distractorRationales),
    qualityFlags: stringifyJsonField(q.qualityFlags),
    points: q.points || 2,
    status: 'PENDING_REVIEW',
  }
}

async function existingOptionSignatures(examId: string): Promise<Set<string>> {
  const rows = await db.programQuestion.findMany({ where: { examId, type: 'MCQ' }, select: { options: true } })
  return new Set(rows.map((q) => optionSignatureFromJson(q.options)).filter(Boolean))
}

async function existingOptionTexts(examId: string): Promise<Set<string>> {
  const rows = await db.programQuestion.findMany({ where: { examId, type: 'MCQ' }, select: { options: true } })
  const out = new Set<string>()
  for (const row of rows) {
    try {
      const arr = JSON.parse(row.options || '[]')
      if (Array.isArray(arr)) {
        for (const opt of arr) {
          const n = normalizeQuestionText(opt)
          if (n) out.add(n)
        }
      }
    } catch {}
  }
  return out
}

async function cleanupDuplicatePendingQuestions(examId: string): Promise<number> {
  const rows = await db.programQuestion.findMany({
    where: { examId, status: 'PENDING_REVIEW' },
    orderBy: { order: 'asc' },
    select: { id: true, text: true, type: true, options: true },
  })
  const seenTexts = new Set<string>()
  const seenOptionSigs = new Set<string>()
  const deleteIds: string[] = []
  for (const row of rows) {
    const textKey = normalizeQuestionText(row.text).slice(0, 180)
    const optSig = row.type === 'MCQ' ? optionSignatureFromJson(row.options) : ''
    const duplicatedText = !!textKey && seenTexts.has(textKey)
    const duplicatedOptions = row.type === 'MCQ' && !!optSig && seenOptionSigs.has(optSig)
    if (duplicatedText || duplicatedOptions) {
      deleteIds.push(row.id)
      continue
    }
    if (textKey) seenTexts.add(textKey)
    if (row.type === 'MCQ' && optSig) seenOptionSigs.add(optSig)
  }
  if (deleteIds.length) await db.programQuestion.deleteMany({ where: { id: { in: deleteIds } } })
  return db.programQuestion.count({ where: { examId } })
}

function filterNewQuestions<T extends { text: string; type?: string; options?: string[] | null }>(
  questions: T[],
  keys: Set<string>,
  optionSigs?: Set<string>,
  optionTexts?: Set<string>
): T[] {
  const out: T[] = []
  for (const q of questions) {
    if (hasBadExamMetadata(`${q.text} ${(q.options || []).join(' ')}`)) continue
    const key = normalizeQuestionText(q.text).slice(0, 160)
    if (!key || keys.has(key)) continue
    const isMcq = String(q.type || '').toUpperCase() === 'MCQ'
    const optSig = isMcq ? optionSignatureFromArray(q.options) : ''
    if (isMcq && optSig && optionSigs?.has(optSig)) continue
    const opts = isMcq && Array.isArray(q.options) ? q.options.map((o) => normalizeQuestionText(o)).filter(Boolean) : []
    if (isMcq && opts.length && optionTexts) {
      const repeatedOptionCount = opts.filter((o) => optionTexts.has(o)).length
      if (repeatedOptionCount >= 2) continue
    }
    keys.add(key)
    if (isMcq && optSig) optionSigs?.add(optSig)
    if (isMcq) for (const opt of opts) optionTexts?.add(opt)
    out.push(q)
  }
  return out
}

function hasBadExamMetadata(value: unknown): boolean {
  const raw = String(value || '')
  const n = normalizeQuestionText(value)
  return (
    /\b\d{1,5}\s+of\s+\d{1,5}\b/i.test(raw) ||
    /(?:^|\s)of\s+\d{1,5}\b/i.test(raw) ||
    n.includes('رابط الكتاب') ||
    n.includes('مصدره') ||
    n.includes('عنوان الكتاب') ||
    n.includes('العنوان الاصلي') ||
    n.includes('ملاحظه قراءه المحتوي') ||
    n.includes('google com search') ||
    n.includes('books google') ||
    n.includes('tbm bks') ||
    n.includes('لم يظهر فيه نص')
  )
}

async function resetLegacyWeakFirstBatchIfNeeded(examId: string, existingCount: number): Promise<number> {
  if (existingCount === 0 || existingCount > totalRequiredQuestions()) return existingCount
  const rows = await db.programQuestion.findMany({
    where: { examId },
    orderBy: { order: 'asc' },
    select: { text: true, options: true, status: true },
  })
  if (!rows.length || rows.some((q) => q.status !== 'PENDING_REVIEW')) return existingCount

  const optionSigs = rows.map((q) => optionSignatureFromJson(q.options)).filter(Boolean)
  const repeatedOptions = new Set(optionSigs).size < optionSigs.length
  const metadataQuestions = rows.some((q) => hasBadExamMetadata(q.text) || hasBadExamMetadata(q.options))
  const genericRepeated = optionSigs.some((sig) =>
    sig.includes(normalizeQuestionText('تحليل المتطلبات والمخاطر ثم اختيار ضوابط قابلة للقياس وفق سياق المؤسسة')) ||
    sig.includes(normalizeQuestionText('تطبيق أداة تقنية واحدة دون تحليل البيئة أو أصحاب المصلحة'))
  )

  if (!metadataQuestions && !repeatedOptions && !genericRepeated) return existingCount

  await db.programQuestion.deleteMany({ where: { examId, status: 'PENDING_REVIEW' } })
  await db.programExam.update({
    where: { id: examId },
    data: {
      status: 'GENERATING',
      totalPoints: 0,
      errorNote: 'حذف النظام الأسئلة القديمة لأنها كانت مبنية على رابط/وصف أو خيارات مكررة، وسيعيد بناءها من محتوى الكتاب المقروء فعلياً',
    },
  }).catch(() => {})
  return 0
}

function groundedTokenSet(value: unknown): string[] {
  const stop = new Set(['هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'على', 'الى', 'في', 'من', 'عن', 'ضمن', 'كتاب', 'الكتاب', 'اداره', 'المشاريع', 'مشروع', 'تخصص', 'تحليل', 'قرار', 'مخاطر', 'تخطيط', 'تنفيذ'])
  return normalizeQuestionText(value).split(' ').filter((t) => t.length >= 4 && !stop.has(t)).slice(0, 40)
}

function questionGroundedInBooks(
  question: { text: string; options: string | null; modelAnswer?: string | null },
  books: { title: string; titleEn?: string | null; textContent?: string | null }[]
): boolean {
  if (hasBadExamMetadata(`${question.text} ${question.options || ''} ${question.modelAnswer || ''}`)) return false
  // التحقق يكون من نص الكتاب المقروء، لا من العنوان أو الوصف، حتى لا نقبل سؤالاً عاماً عن تخصص آخر أو عنوان مرجع خارجي.
  const source = normalizeQuestionText(books.map((b) => String(b.textContent || '').slice(0, 70000)).join(' '))
  const combined = `${question.text} ${question.options || ''} ${question.modelAnswer || ''}`
  const tokens = groundedTokenSet(combined)
  if (!source || tokens.length === 0) return false
  const hits = tokens.filter((t) => source.includes(t)).length
  return hits >= Math.min(5, Math.max(2, Math.ceil(tokens.length * 0.18)))
}

async function resetUngroundedPendingQuestionsIfNeeded(
  examId: string,
  books: { title: string; titleEn?: string | null; textContent?: string | null }[],
  existingCount: number
): Promise<number> {
  if (existingCount === 0) return existingCount
  const rows = await db.programQuestion.findMany({
    where: { examId },
    orderBy: { order: 'asc' },
    select: { text: true, options: true, modelAnswer: true, status: true },
  })
  if (!rows.length || rows.some((q) => q.status !== 'PENDING_REVIEW')) return existingCount

  const optionSigs = rows.map((q) => optionSignatureFromJson(q.options)).filter(Boolean)
  const repeatedOptions = new Set(optionSigs).size < optionSigs.length
  const ungrounded = rows.filter((q) => !questionGroundedInBooks(q, books)).length
  if (!repeatedOptions && ungrounded < Math.max(2, Math.ceil(rows.length * 0.35))) return existingCount

  await db.programQuestion.deleteMany({ where: { examId, status: 'PENDING_REVIEW' } })
  await db.programExam.update({
    where: { id: examId },
    data: {
      status: 'GENERATING',
      totalPoints: 0,
      errorNote: 'حذف النظام الأسئلة لأنها لا تستند كفاية إلى محتوى الكتاب المقروء أو فيها خيارات مكررة، وسيعيد بناء الامتحان من الكتاب نفسه',
    },
  }).catch(() => {})
  return 0
}

async function exposeExamForReview(examId: string, note?: string) {
  const totals = await examTotals(examId)
  const status = totals.questionCount >= 10 ? 'REVIEW' : 'FAILED'
  await db.programExam.update({
    where: { id: examId },
    data: {
      status,
      totalPoints: totals.totalPoints,
      durationMin: totals.questionCount > 0 ? Math.max(120, Math.min(240, Math.round(totals.questionCount * 2))) : 120,
      errorNote: note || (status === 'REVIEW'
        ? `تم نقل ${totals.questionCount} سؤالاً للمراجعة بعد توقف التوليد`
        : 'فشل التوليد قبل إنشاء الحد الأدنى من الأسئلة'),
    },
  })
  return { ok: status === 'REVIEW', status, inserted: 0, done: status === 'REVIEW', ...totals }
}

async function runGenerationStep(examId: string): Promise<{ ok: boolean; status: string; inserted: number; questionCount: number; totalPoints: number; done: boolean; batchIndex?: number; error?: string }> {
  try {
    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
    })
    if (!exam) return { ok: false, status: 'MISSING', inserted: 0, questionCount: 0, totalPoints: 0, done: true, error: 'الامتحان غير موجود' }
    if (exam.status === 'READY' || exam.status === 'REVIEW') {
      const totals = await examTotals(examId)
      return { ok: true, status: exam.status, inserted: 0, done: true, ...totals }
    }
    if (exam.status !== 'GENERATING') {
      await db.programExam.update({ where: { id: examId }, data: { status: 'GENERATING', errorNote: null } })
    }

    const books = await db.book.findMany({
      where: { programId: exam.programId, OR: [{ semester: null }, { semester: exam.semester }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        titleEn: true,
        author: true,
        year: true,
        description: true,
        link: true,
        fileName: true,
        mimeType: true,
        size: true,
        data: true,
        textContent: true,
        levelPolicy: true,
        readingDepth: true,
        assessmentOrientation: true,
        linkReadStatus: true,
        linkReadNote: true,
      },
    })
    if (books.length === 0) throw new Error(`لا توجد كتب مقررة للفصل ${exam.semester === 2 ? 'الثاني' : 'الأول'}`)

    // مهم: الاستكمال لا يصفر الامتحان إطلاقاً. نزيل فقط النسخ المكررة حرفياً ونكمل من آخر سؤال محفوظ.
    let existingCount = await cleanupDuplicatePendingQuestions(examId)

    const hydratedBooks = []
    for (const book of books) {
      if (!(await isExamStillGenerating(examId))) {
        const totals = await examTotals(examId)
        return { ok: true, status: 'STOPPED', inserted: 0, done: true, ...totals }
      }
      const hydrated = await hydrateBookContentForExam(book)
      hydratedBooks.push(hydrated)
      if (hydrated.shouldPersistText && hydrated.id && hydrated.textContent.length >= 160) {
        await db.book.update({
          where: { id: hydrated.id },
          data: {
            textContent: hydrated.textContent.slice(0, 180000),
            linkReadStatus: hydrated.contentQuality === 'LINK_TEXT' ? 'TEXT_EXTRACTED' : hydrated.contentQuality === 'NO_CONTENT' ? 'FAILED' : 'FILE_EXTRACTED',
            linkReadNote: hydrated.sourceNote,
          },
        }).catch(() => {})
      }
    }

    const usableBooks = hydratedBooks.filter((b) =>
      b.contentQuality !== 'METADATA_ONLY' &&
      b.contentQuality !== 'NO_CONTENT' &&
      String(b.textContent || '').trim().length >= 300
    )
    if (usableBooks.length === 0) {
      const notes = hydratedBooks.map((b) => `«${b.title}»: ${b.sourceNote}`).join(' — ').slice(0, 700)
      throw new Error(`لا يوجد نص فعلي مقروء من الكتب. ارفع ملف Word/PDF/TXT قابل للقراءة أو ضع رابط PDF مباشر، ولا تستخدم رابط بحث Google أو صفحة وصف فقط. ${notes}`)
    }

    const knowledgeContext = await buildKnowledgeContextForExam(exam.programId, exam.semester, 56).catch((e) => {
      console.error('knowledge context for exam failed:', String(e?.message || e).slice(0, 300))
      return ''
    })
    // بنك المعرفة يستخدم كمرشد تنظيمي منفصل فقط، ولا يعامل ككتاب مصدر حتى لا تتسرب عبارات داخلية مثل «محور معرفي مهم» إلى نص السؤال.
    const examSourceBooks: ExamSourceBook[] = usableBooks

    // لا نحذف الدفعات السابقة هنا حتى لو كانت بحاجة مراجعة؛ نمنع السيئ في الدفعات الجديدة ونترك القديم للمراجعة أو زر إعادة البناء.
    const batchIndex = firstMissingBatchIndex(existingCount)
    if (batchIndex >= EXAM_BATCH_COUNT) {
      const reviewed = await exposeExamForReview(examId, null)
      return { ...reviewed, ok: true, done: true }
    }

    const previousQuestions = await db.programQuestion.findMany({
      where: { examId },
      orderBy: { order: 'asc' },
      select: { text: true, options: true },
    })
    const previousTexts = previousQuestions.map((q) => {
      let optionsText = ''
      try {
        const opts = JSON.parse(q.options || '[]')
        if (Array.isArray(opts) && opts.length) optionsText = ` | خيارات سابقة: ${opts.join(' / ')}`
      } catch {}
      return `${q.text}${optionsText}`
    })
    const existingKeys = await existingQuestionKeys(examId)
    const existingOptions = await existingOptionSignatures(examId)
    const existingOptionWords = await existingOptionTexts(examId)

    let batch = await generateExamQuestionBatch(exam.program, examSourceBooks, batchIndex, previousTexts, knowledgeContext)
    batch = filterNewQuestions(batch, existingKeys, existingOptions, existingOptionWords)
    if (batch.length < EXAM_BATCH_SPECS[batchIndex].count) {
      const fallbackKeys = await existingQuestionKeys(examId)
      const fallbackOptions = await existingOptionSignatures(examId)
      const fallbackOptionWords = await existingOptionTexts(examId)
      for (const q of batch) {
        fallbackKeys.add(normalizeQuestionText(q.text).slice(0, 160))
        const optSig = optionSignatureFromArray(q.options)
        if (optSig) fallbackOptions.add(optSig)
        for (const opt of q.options || []) {
          const n = normalizeQuestionText(opt)
          if (n) fallbackOptionWords.add(n)
        }
      }
      for (let attempt = 0; attempt < EXAM_BATCH_COUNT && batch.length < EXAM_BATCH_SPECS[batchIndex].count; attempt++) {
        const fallback = filterNewQuestions(
          fallbackExamQuestionBatch(exam.program, examSourceBooks, batchIndex + attempt),
          fallbackKeys,
          fallbackOptions,
          fallbackOptionWords
        )
        batch = [...batch, ...fallback].slice(0, EXAM_BATCH_SPECS[batchIndex].count)
      }
    }
    if (batch.length === 0) throw new Error(`فشل توليد أسئلة جديدة غير مكررة للدفعة ${batchIndex + 1}`)

    if (!(await isExamStillGenerating(examId))) {
      const totals = await examTotals(examId)
      return { ok: true, status: 'STOPPED', inserted: 0, done: true, ...totals }
    }

    // منع التكرار إذا دخل طلبان في نفس اللحظة: نعيد فحص العدد قبل الإدخال.
    const latestCount = await db.programQuestion.count({ where: { examId } })
    if (latestCount !== existingCount) {
      const totals = await examTotals(examId)
      return { ok: true, status: 'GENERATING', inserted: 0, done: false, batchIndex, ...totals }
    }

    const maxOrder = await db.programQuestion.aggregate({ where: { examId }, _max: { order: true } })
    let order = maxOrder._max.order || existingCount || 0
    await db.programQuestion.createMany({
      data: batch.map((q) => createProgramQuestionData(examId, ++order, q)),
    })

    const totals = await examTotals(examId)
    const done = firstMissingBatchIndex(totals.questionCount) >= EXAM_BATCH_COUNT
    await db.programExam.update({
      where: { id: examId },
      data: {
        status: done ? 'REVIEW' : 'GENERATING',
        totalPoints: totals.totalPoints,
        durationMin: Math.max(120, Math.min(240, Math.round(totals.questionCount * 2))),
        errorNote: done ? null : `تم توليد ${totals.questionCount} سؤالاً من أصل ${totalRequiredQuestions()} — اضغط تحريك/استكمال أو اترك الصفحة مفتوحة ليكمل على دفعات`,
        booksUsed: [
          ...(knowledgeContext ? ['بنك المعرفة الأكاديمي المستخرج من الكتب'] : []),
          ...usableBooks.map((b) => `«${b.title}» (${b.sourceNote})`),
        ].join('، ').slice(0, 2000),
      },
    })

    return { ok: true, status: done ? 'REVIEW' : 'GENERATING', inserted: batch.length, done, batchIndex, ...totals }
  } catch (e: any) {
    const message = String(e?.message || 'خطأ غير متوقع أثناء التوليد').slice(0, 500)
    const totals = await examTotals(examId).catch(() => ({ questionCount: 0, totalPoints: 0 }))
    if (totals.questionCount >= totalRequiredQuestions()) {
      const reviewed = await exposeExamForReview(examId, null)
      return { ...reviewed, ok: true, done: true, error: message }
    }
    await db.programExam.update({
      where: { id: examId },
      data: {
        status: 'FAILED',
        errorNote: `توقف التوليد بعد حفظ ${totals.questionCount} سؤالاً من أصل ${totalRequiredQuestions()}: ${message} — اضغط استكمال/تحريك ليكمل من حيث توقف دون تكرار`,
        totalPoints: totals.totalPoints,
      },
    }).catch(() => {})
    return { ok: false, status: 'FAILED', inserted: 0, done: false, error: message, ...totals }
  }
}

async function runGenerationSteps(
  examId: string,
  maxSteps = 1
): Promise<{ ok: boolean; status: string; inserted: number; questionCount: number; totalPoints: number; done: boolean; batchIndex?: number; error?: string }> {
  let totalInserted = 0
  let last: Awaited<ReturnType<typeof runGenerationStep>> | null = null
  for (let i = 0; i < maxSteps; i++) {
    last = await runGenerationStep(examId)
    totalInserted += last.inserted || 0
    if (last.done || last.status !== 'GENERATING' || !last.ok || last.inserted === 0) break
  }
  if (!last) return { ok: false, status: 'FAILED', inserted: 0, questionCount: 0, totalPoints: 0, done: true, error: 'لم يبدأ التوليد' }
  return { ...last, inserted: totalInserted }
}

async function ensureStarterQuestions(examId: string): Promise<{ inserted: number; questionCount: number }> {
  const existingCount = await db.programQuestion.count({ where: { examId } })
  if (existingCount > 0) return { inserted: 0, questionCount: existingCount }

  // لا نضع أسئلة احتياطية قبل قراءة الكتاب. الدفعة الأولى نفسها تُبنى عبر runGenerationStep
  // من محتوى الملف/الرابط، وإذا تعطل مزود الذكاء فقط نستخدم fallback مرتبطاً بالمحتوى.
  const step = await runGenerationSteps(examId, 1)
  return { inserted: step.inserted, questionCount: step.questionCount }
}

// ===== التوليد الخلفي لامتحان الفصل الدراسي من الكتب =====
// 12.2: كل برنامج له امتحانان (فصل أول + فصل ثانٍ) — الأسئلة تولد بحالة "بانتظار مراجعة الإدارة"
// (Human-in-the-loop) ولا تُنشر للطلاب إلا بعد اعتماد الإدارة.

async function runGeneration(examId: string) {
  try {
    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
    })
    if (!exam || exam.status !== 'GENERATING') return

    const semester = exam.semester
    const books = await db.book.findMany({
      where: { programId: exam.programId, OR: [{ semester: null }, { semester }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        titleEn: true,
        author: true,
        year: true,
        description: true,
        link: true,
        fileName: true,
        mimeType: true,
        size: true,
        data: true,
        textContent: true,
        levelPolicy: true,
        readingDepth: true,
        assessmentOrientation: true,
        linkReadStatus: true,
        linkReadNote: true,
      },
    })
    if (books.length === 0) throw new Error(`لا توجد كتب مقررة للفصل ${semester === 2 ? 'الثاني' : 'الأول'}`)

    const hydratedBooks = []
    for (const book of books) {
      if (!(await isExamStillGenerating(examId))) return
      const hydrated = await hydrateBookContentForExam(book)
      hydratedBooks.push(hydrated)
      if (hydrated.shouldPersistText && hydrated.id && hydrated.textContent.length >= 160) {
        await db.book.update({
          where: { id: hydrated.id },
          data: {
            textContent: hydrated.textContent.slice(0, 180000),
            linkReadStatus: hydrated.contentQuality === 'LINK_TEXT' ? 'TEXT_EXTRACTED' : hydrated.contentQuality === 'NO_CONTENT' ? 'FAILED' : 'FILE_EXTRACTED',
            linkReadNote: hydrated.sourceNote,
          },
        }).catch(() => {})
      }
    }

    const usableBooks = hydratedBooks.filter((b) =>
      b.contentQuality !== 'METADATA_ONLY' &&
      b.contentQuality !== 'NO_CONTENT' &&
      String(b.textContent || '').trim().length >= 300
    )
    if (usableBooks.length === 0) throw new Error('لا يوجد نص فعلي مقروء من الكتب لبناء الامتحان')
    const knowledgeContext = await buildKnowledgeContextForExam(exam.programId, exam.semester, 56).catch(() => '')
    // بنك المعرفة يستخدم كمرشد تنظيمي منفصل، أما sourceEvidence فيجب أن يأتي من نصوص الكتب الفعلية.
    const examSourceBooks: ExamSourceBook[] = usableBooks

    const existingCount = await db.programQuestion.count({ where: { examId } })
    const maxOrder = await db.programQuestion.aggregate({ where: { examId }, _max: { order: true } })
    let order = maxOrder._max.order || existingCount || 0
    const startBatch = firstMissingBatchIndex(existingCount)

    for (let i = startBatch; i < EXAM_BATCH_COUNT; i++) {
      if (!(await isExamStillGenerating(examId))) return
      const spec = EXAM_BATCH_SPECS[i]
      let batch = await generateExamQuestionBatch(exam.program, examSourceBooks, i, [], knowledgeContext)
      if (batch.length === 0) {
        // إعادة محاولة واحدة عند فشل الدفعة
        batch = await generateExamQuestionBatch(exam.program, examSourceBooks, i, [], knowledgeContext)
      }
      if (batch.length === 0) throw new Error(`فشل توليد الدفعة ${i + 1} من الأسئلة`)
      if (!(await isExamStillGenerating(examId))) return

      await db.programQuestion.createMany({
        data: batch.map((q) => createProgramQuestionData(examId, ++order, q)),
      })
      const totalNow = await db.programQuestion.count({ where: { examId } })
      await db.programExam.update({
        where: { id: examId },
        data: {
          durationMin: Math.max(120, Math.min(240, Math.round(totalNow * 2))),
          booksUsed: [
            ...(knowledgeContext ? ['بنك المعرفة الأكاديمي المستخرج من الكتب'] : []),
            ...usableBooks.map((b) => `«${b.title}» (${b.sourceNote})`),
          ].join('، ').slice(0, 2000),
        },
      })
    }

    const allQuestions = await db.programQuestion.findMany({ where: { examId }, select: { points: true } })
    const totalPoints = allQuestions.reduce((s, q) => s + q.points, 0)
    const totalQ = allQuestions.length

    await db.programExam.updateMany({
      where: { id: examId, status: 'GENERATING' },
      data: {
        // بانتظار مراجعة الإدارة واعتماد الأسئلة قبل النشر للطلاب
        status: 'REVIEW',
        durationMin: Math.max(120, Math.min(240, Math.round(totalQ * 2))),
        totalPoints,
        errorNote: null,
      },
    })
  } catch (e: any) {
    console.error('exam generation error:', e)
    await db.programExam
      .updateMany({
        where: { id: examId, status: 'GENERATING' },
        data: { status: 'FAILED', errorNote: String(e?.message || 'خطأ غير متوقع أثناء التوليد').slice(0, 500) },
      })
      .catch(() => {})
  }
}

// POST /api/admin/program-exams/generate — بدء أو استكمال توليد امتحان فصل دراسي من الكتب المقررة
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const examId = String(body?.examId || '').trim()
    const programId = String(body?.programId || '').trim()
    const sem = Number(body?.semester) === 2 ? 2 : 1

    if (body?.action === 'stop') {
      if (!examId) return NextResponse.json({ error: 'معرف الامتحان مطلوب لإيقاف التوليد' }, { status: 400 })
      const stopped = await stopGenerationAndExposeReview(examId, { id: admin.id, name: admin.name })
      if ('error' in stopped) return NextResponse.json({ error: stopped.error }, { status: stopped.statusCode || 400 })
      return NextResponse.json(stopped)
    }

    if (body?.action === 'rebuild') {
      if (!examId) return NextResponse.json({ error: 'معرف الامتحان مطلوب لإعادة البناء' }, { status: 400 })
      const existing = await db.programExam.findUnique({
        where: { id: examId },
        include: { program: { select: { titleAr: true } }, _count: { select: { questions: true } } },
      })
      if (!existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (existing.status === 'READY') return NextResponse.json({ error: 'الامتحان منشور للطلاب — احذفه وأنشئ امتحاناً جديداً إذا أردت إعادة البناء' }, { status: 409 })
      await db.programQuestion.deleteMany({ where: { examId } })
      await db.programExam.update({
        where: { id: examId },
        data: { status: 'GENERATING', errorNote: null, totalPoints: 0, booksUsed: null },
      })
      await audit(
        { id: admin.id, name: admin.name },
        'REBUILD_PROGRAM_EXAM_FROM_BOOKS',
        'ProgramExam',
        examId,
        `إعادة بناء امتحان ${existing.program.titleAr} من الكتب بعد حذف ${existing._count.questions} سؤالاً سابقاً`
      )
      const step = await runGenerationSteps(examId, 1)
      return NextResponse.json({ ok: step.ok, examId, rebuilt: true, ...step, requiredQuestions: totalRequiredQuestions() })
    }

    if (body?.action === 'kick') {
      if (!examId) return NextResponse.json({ error: 'معرف الامتحان مطلوب لتحريك التوليد' }, { status: 400 })
      const existing = await db.programExam.findUnique({ where: { id: examId }, select: { id: true, status: true } })
      if (!existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (existing.status === 'READY') return NextResponse.json({ error: 'الامتحان منشور بالفعل' }, { status: 409 })
      if (existing.status !== 'GENERATING') {
        await db.programExam.update({ where: { id: examId }, data: { status: 'GENERATING', errorNote: null } })
      }
      const step = await runGenerationSteps(examId, 1)
      return NextResponse.json({ ok: step.ok, examId, kicked: true, ...step, requiredQuestions: totalRequiredQuestions() })
    }

    if (examId) {
      const existing = await db.programExam.findUnique({
        where: { id: examId },
        include: {
          program: { select: { id: true, titleAr: true, category: true } },
          _count: { select: { questions: true } },
        },
      })
      if (!existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (existing.status === 'GENERATING') {
        const step = await runGenerationSteps(existing.id, 1)
        return NextResponse.json({
          ok: step.ok,
          examId: existing.id,
          resumed: true,
          kicked: true,
          existingQuestions: step.questionCount,
          inserted: step.inserted,
          status: step.status,
          done: step.done,
          requiredQuestions: totalRequiredQuestions(),
        })
      }
      if (existing.status === 'READY') {
        return NextResponse.json({ error: 'الامتحان منشور للطلاب — استخدم زر الحذف إذا أردت إنشاء امتحان جديد بالكامل' }, { status: 409 })
      }

      const booksCount = await db.book.count({
        where: { programId: existing.programId, OR: [{ semester: null }, { semester: existing.semester }] },
      })
      if (booksCount === 0) {
        return NextResponse.json(
          { error: `لا توجد كتب مقررة للفصل ${existing.semester === 2 ? 'الثاني' : 'الأول'} — أضف كتباً لهذا الفصل أو اجعل بعض الكتب «عامة للبرنامج»` },
          { status: 400 }
        )
      }

      await db.programExam.update({
        where: { id: existing.id },
        data: { status: 'GENERATING', errorNote: null },
      })

      await audit(
        { id: admin.id, name: admin.name },
        'RESUME_PROGRAM_EXAM_GENERATION',
        'ProgramExam',
        existing.id,
        `استكمال توليد امتحان الفصل ${existing.semester === 2 ? 'الثاني' : 'الأول'} من السؤال ${existing._count.questions + 1} لبرنامج ${existing.program.titleAr}`
      )

      const step = await runGenerationSteps(existing.id, 1)

      return NextResponse.json({
        ok: step.ok,
        examId: existing.id,
        booksCount,
        semester: existing.semester,
        resumed: true,
        existingQuestions: step.questionCount || existing._count.questions,
        inserted: step.inserted,
        status: step.status,
        done: step.done,
        requiredQuestions: totalRequiredQuestions(),
      })
    }

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, category: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const booksCount = await db.book.count({ where: { programId, OR: [{ semester: null }, { semester: sem }] } })
    if (booksCount === 0) {
      return NextResponse.json(
        { error: `لا توجد كتب مقررة للفصل ${sem === 2 ? 'الثاني' : 'الأول'} — أضف كتباً لهذا الفصل أو اجعل بعض الكتب «عامة للبرنامج»` },
        { status: 400 }
      )
    }

    const generating = await db.programExam.findFirst({ where: { programId, status: 'GENERATING' } })
    if (generating) {
      const step = await runGenerationSteps(generating.id, 1)
      return NextResponse.json({
        ok: step.ok,
        examId: generating.id,
        booksCount,
        semester: generating.semester,
        resumed: true,
        kicked: true,
        existingQuestions: step.questionCount,
        inserted: step.inserted,
        status: step.status,
        done: step.done,
        requiredQuestions: totalRequiredQuestions(),
      })
    }

    const existingSemExam = await db.programExam.findFirst({
      where: { programId, semester: sem, status: { in: ['REVIEW', 'READY'] } },
      include: { _count: { select: { questions: true } } },
    })
    if (existingSemExam) {
      if (existingSemExam.status === 'REVIEW' && existingSemExam._count.questions < totalRequiredQuestions()) {
        await db.programExam.update({ where: { id: existingSemExam.id }, data: { status: 'GENERATING', errorNote: null } })
        const step = await runGenerationSteps(existingSemExam.id, 1)
        return NextResponse.json({
          ok: step.ok,
          examId: existingSemExam.id,
          booksCount,
          semester: sem,
          resumed: true,
          continuedFromReview: true,
          existingQuestions: step.questionCount,
          inserted: step.inserted,
          status: step.status,
          done: step.done,
          requiredQuestions: totalRequiredQuestions(),
        })
      }
      return NextResponse.json(
        { error: `يوجد امتحان ${existingSemExam.status === 'READY' ? 'منشور' : 'بانتظار المراجعة'} للفصل ${sem === 2 ? 'الثاني' : 'الأول'} — استخدم زر الحذف أو زر إعادة البناء داخل المراجعة إذا أردت نسخة جديدة` },
        { status: 409 }
      )
    }

    const failedSemExam = await db.programExam.findFirst({
      where: { programId, semester: sem, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { questions: true } } },
    })
    if (failedSemExam) {
      await db.programExam.update({ where: { id: failedSemExam.id }, data: { status: 'GENERATING', errorNote: null } })
      await audit(
        { id: admin.id, name: admin.name },
        'RESUME_PROGRAM_EXAM_GENERATION',
        'ProgramExam',
        failedSemExam.id,
        `استكمال توليد امتحان فاشل سابقاً للفصل ${sem === 2 ? 'الثاني' : 'الأول'} من السؤال ${failedSemExam._count.questions + 1} لبرنامج ${program.titleAr}`
      )
      const step = await runGenerationSteps(failedSemExam.id, 1)
      return NextResponse.json({
        ok: step.ok,
        examId: failedSemExam.id,
        booksCount,
        semester: sem,
        resumed: true,
        existingQuestions: step.questionCount || failedSemExam._count.questions,
        inserted: step.inserted,
        status: step.status,
        done: step.done,
        requiredQuestions: totalRequiredQuestions(),
      })
    }

    const semLabel = sem === 2 ? 'الثاني' : 'الأول'
    const exam = await db.programExam.create({
      data: {
        programId,
        semester: sem,
        title: `امتحان الفصل الدراسي ${semLabel} — ${program.titleAr}`,
        status: 'GENERATING',
        durationMin: 120,
        generatedBy: 'AI',
      },
    })

    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_PROGRAM_EXAM',
      'ProgramExam',
      exam.id,
      `توليد امتحان الفصل ${semLabel} من ${booksCount} كتاب مقرر لبرنامج ${program.titleAr}`
    )

    // نُنشئ الدفعة الأولى الآن من محتوى الكتاب/الرابط. بقية الدفعات تكملها الواجهة تدريجياً عبر زر/تحريك التوليد.
    const starter = await ensureStarterQuestions(exam.id)

    return NextResponse.json({
      ok: true,
      examId: exam.id,
      booksCount,
      semester: sem,
      resumed: false,
      existingQuestions: starter.questionCount,
      inserted: starter.inserted,
      requiredQuestions: totalRequiredQuestions(),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-exam generate error:', e)
    return NextResponse.json({ error: 'تعذر بدء التوليد' }, { status: 500 })
  }
}
