// Comprehensive exam for external graduates — phase 1 (preparation only).
// Pure helpers: no DB import, so they are directly unit-testable.
// Closed questions ONLY (MCQ | TF). There is no essay type anywhere in
// this module — not in the schema, not in validation, not in import.
import * as XLSX from 'xlsx'

// Academic-scope guards: prevent degree admissions/program trivia from becoming
// professional specialty questions even if a retrieved source is genuinely quoted.
function normalizeInternetAcademicText(value: string): string {
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

const DEGREE_WORDS = /(?:\bdba\b|\bmba\b|\bphd\b|دكتوراه|ماجستير|دبلوم|بكالوريوس)/u
const ADMISSION_WORDS = /(?:القبول|الالتحاق|التسجيل|رسوم الدراسه|الرسوم الدراسيه|تكاليف الدراسه|شروط التقديم|الفئه المستهدفه|خريجي الماجستير)/u
const PROGRAM_META_WORDS = /(?:برنامج|درجه|شهاده|مؤسسه|كليه|جامعه|القبول|الالتحاق|التسجيل|الفئه المستهدفه|مدة الدراسه|مده الدراسه)/u
const PROGRAM_ONLY_WORDS = new Set(['برنامج', 'دكتوراه', 'ماجستير', 'دبلوم', 'مهنيه', 'المهنيه', 'الدراسه', 'الاعمال', 'اداره', 'في', 'ال', 'الـ', 'dba', 'mba', 'phd'])

export function internetAcademicTopicIssue(topic: string, specializationTitle: string): string | null {
  const term = normalizeInternetAcademicText(topic)
  if (!term || term.length < 5) return 'اكتب محوراً علمياً واضحاً من التخصص، لا اسم الدرجة فقط.'
  if (ADMISSION_WORDS.test(term)) return 'موضوع القبول أو التسجيل لا يقيس كفاءة التخصص؛ اختر محوراً علمياً من المنهج.'
  const programWords = new Set(normalizeInternetAcademicText(specializationTitle).split(' ').filter(Boolean))
  const specializedWords = term.split(' ').filter((word) => word.length >= 3 && !PROGRAM_ONLY_WORDS.has(word) && !programWords.has(word))
  if (!specializedWords.length) return 'اسم برنامج الدكتوراه وحده ينتج أسئلة عن الالتحاق؛ اكتب موضوعاً تخصصياً مثل الإدارة الاستراتيجية أو مناهج البحث التطبيقي.'
  return null
}

export function internetSourceAcademicIssue(title: string, content: string): string | null {
  const excerpt = normalizeInternetAcademicText(`${title} ${content}`)
  if (DEGREE_WORDS.test(excerpt) && ADMISSION_WORDS.test(excerpt)) return 'DEGREE_ADMISSIONS_SOURCE'
  return null
}

export function internetQuestionAcademicIssue(questionText: string): string | null {
  const question = normalizeInternetAcademicText(questionText)
  if (ADMISSION_WORDS.test(question) && (DEGREE_WORDS.test(question) || /برنامج|مؤسسه|كليه|جامعه/u.test(question))) {
    return 'DEGREE_ADMISSIONS_QUESTION'
  }
  if (DEGREE_WORDS.test(question) && PROGRAM_META_WORDS.test(question)) {
    return 'DEGREE_PROGRAM_METADATA_QUESTION'
  }
  return null
}

export const COMPREHENSIVE_EXAM_QUESTION_COUNT = 100
export const COMPREHENSIVE_EXAM_POINTS_PER_QUESTION = 2
export const COMPREHENSIVE_EXAM_TF_OPTIONS = ['صح', 'خطأ'] as const
export const COMPREHENSIVE_EXAM_TYPES = ['MCQ', 'TF'] as const
export const COMPREHENSIVE_EXAM_QUESTION_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const
export const COMPREHENSIVE_EXAM_SOURCES = ['BANK', 'MANUAL', 'EXCEL_IMPORT', 'DOC_IMPORT', 'AI_INTERNET'] as const
export const COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS = 500

export type ComprehensiveExamQuestionType = 'MCQ' | 'TF'
export type ComprehensiveExamQuestionSource = 'BANK' | 'MANUAL' | 'EXCEL_IMPORT' | 'DOC_IMPORT' | 'AI_INTERNET'

export type ComprehensiveQuestionInput = {
  type: ComprehensiveExamQuestionType
  text: string
  options: string[]
  correctAnswer: string
  sourceEvidence?: string | null
}

export function cleanComprehensiveText(value: unknown, max = 1200): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normHeader(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// MCQ: 3–4 cleaned options (same bound as the question bank's sanitizer,
// which caps at 4). TF: the fixed pair, whatever the caller passed.
export function normalizeComprehensiveOptions(
  type: ComprehensiveExamQuestionType,
  raw: unknown,
): string[] | null {
  if (type === 'TF') return [...COMPREHENSIVE_EXAM_TF_OPTIONS]
  const arr = Array.isArray(raw) ? raw : []
  const options = arr.map((x) => cleanComprehensiveText(x, 260)).filter(Boolean).slice(0, 4)
  return options.length >= 3 ? options : null
}

export function parseComprehensiveType(value: unknown): ComprehensiveExamQuestionType | null {
  const v = normHeader(value)
  if (['tf', 'صح خطا', 'صح او خطا', 'صواب خطا', 'true false'].includes(v)) return 'TF'
  if (['mcq', 'اختيار متعدد', 'اختيار من متعدد', 'multiple choice', 'اختيارات'].includes(v)) return 'MCQ'
  return null
}

// Numeric MCQ answers are ambiguous ("1" can mean the first option in
// Excel or the second option in the stored/UI zero-based contract).
// Callers must choose their index base explicitly when using zero-based
// values. The default preserves the legacy 1-based import format.
export function parseComprehensiveCorrectAnswer(
  type: ComprehensiveExamQuestionType,
  value: unknown,
  options: string[],
  numericIndexBase: 0 | 1 = 1,
): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (type === 'TF') {
    if (['0', 'صح', 'صواب', 'true', 'نعم'].includes(raw)) return '0'
    if (['1', 'خطا', 'خطأ', 'false', 'لا'].includes(raw)) return '1'
    return null
  }
  const n = Number(raw)
  if (numericIndexBase === 0) {
    if (Number.isInteger(n) && n >= 0 && n < options.length && String(n) === raw) return String(n)
  } else {
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return String(n - 1)
    if (Number.isInteger(n) && n >= 0 && n < options.length && String(n) === raw) return String(n)
  }
  const idx = options.findIndex((o) => o === raw || normHeader(o) === normHeader(raw))
  return idx >= 0 ? String(idx) : null
}

export type ValidatedComprehensiveQuestion =
  | { ok: true; question: ComprehensiveQuestionInput }
  | { ok: false; errors: string[] }

// The single validation gate for every question entering a comprehensive
// exam, whatever the source. ESSAY/SHORT are rejected here by type.
export function validateComprehensiveQuestion(raw: {
  type?: unknown
  text?: unknown
  options?: unknown
  correctAnswer?: unknown
  correctAnswerIndexBase?: 0 | 1
  sourceEvidence?: unknown
}): ValidatedComprehensiveQuestion {
  const errors: string[] = []
  const type = parseComprehensiveType(raw?.type)
  if (!type) {
    errors.push('نوع السؤال غير معروف — المسموح فقط: صح/خطأ أو اختيار متعدد (لا مقالي)')
    return { ok: false, errors }
  }
  const text = cleanComprehensiveText(raw?.text, 1200)
  if (text.length < 10) errors.push('نص السؤال قصير جداً (10 أحرف على الأقل)')
  const options = normalizeComprehensiveOptions(type, raw?.options)
  if (!options) errors.push(type === 'MCQ' ? 'الاختيار المتعدد يحتاج 3–4 خيارات' : 'سؤال صح/خطأ يحتاج خيارين')
  const correctAnswer = options ? parseComprehensiveCorrectAnswer(type, raw?.correctAnswer, options, raw?.correctAnswerIndexBase ?? 1) : null
  if (!correctAnswer) errors.push('الإجابة الصحيحة غير صالحة — رقم خيار أو نص خيار أو صح/خطأ')
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    question: {
      type,
      text,
      options: options as string[],
      correctAnswer: correctAnswer as string,
      sourceEvidence: cleanComprehensiveText(raw?.sourceEvidence, 1800) || null,
    },
  }
}

export type ComprehensivePublishCheck =
  | { ok: true; approved: number }
  | { ok: false; approved: number; needed?: number; excess?: number; reason: string }

// The publish gate: exactly 100 approved questions. Fewer → the admin
// still has work; more → the admin must unapprove/remove the surplus —
// the system never picks questions on the admin's behalf.
export function checkComprehensivePublishGate(approvedCount: number): ComprehensivePublishCheck {
  if (approvedCount === COMPREHENSIVE_EXAM_QUESTION_COUNT) return { ok: true, approved: approvedCount }
  if (approvedCount < COMPREHENSIVE_EXAM_QUESTION_COUNT) {
    return {
      ok: false,
      approved: approvedCount,
      needed: COMPREHENSIVE_EXAM_QUESTION_COUNT - approvedCount,
      reason: `الامتحان يحتاج 100 سؤال معتمد بالضبط للنشر — المعتمد الآن ${approvedCount}، ينقص ${COMPREHENSIVE_EXAM_QUESTION_COUNT - approvedCount}.`,
    }
  }
  return {
    ok: false,
    approved: approvedCount,
    excess: approvedCount - COMPREHENSIVE_EXAM_QUESTION_COUNT,
    reason: `عدد الأسئلة المعتمدة ${approvedCount} يتجاوز 100 بـ${approvedCount - COMPREHENSIVE_EXAM_QUESTION_COUNT} — ألغِ اعتماد الزائد أو احذفه قبل النشر.`,
  }
}

export function comprehensiveQuestionCounts(
  questions: Array<{ status: string }>,
): { total: number; approved: number; pending: number; rejected: number } {
  return {
    total: questions.length,
    approved: questions.filter((q) => q.status === 'APPROVED').length,
    pending: questions.filter((q) => q.status === 'PENDING_REVIEW').length,
    rejected: questions.filter((q) => q.status === 'REJECTED').length,
  }
}

// ---- Excel import ----

const QUESTION_HEADERS = new Set(['السؤال', 'السوال', 'question', 'text', 'نص السوال'])
const TYPE_HEADERS = new Set(['النوع', 'نوع السوال', 'type'])
const ANSWER_HEADERS = new Set(['الاجابه الصحيحه', 'الاجابة الصحيحة', 'correct answer', 'correctanswer', 'answer'])
const EVIDENCE_HEADERS = new Set(['الدليل', 'المصدر', 'الدليل من الكتاب', 'source evidence', 'evidence'])
const OPTION_HEADERS = ['الخيار 1', 'الخيار 2', 'الخيار 3', 'الخيار 4', 'option 1', 'option 2', 'option 3', 'option 4']

function headerIndex(headers: string[], wanted: Set<string>): number {
  return headers.findIndex((h) => wanted.has(normHeader(h)))
}

export type ComprehensiveExcelParseResult = {
  questions: ComprehensiveQuestionInput[]
  errors: Array<{ row: number; message: string }>
  skippedEmpty: number
}

// Reads the first sheet only. The header row is the first row containing
// a recognized question header. Rows that fail validation are collected
// with their row number and never stop the rest of the file.
export function parseComprehensiveExamExcel(buffer: Buffer): ComprehensiveExcelParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return { questions: [], errors: [{ row: 0, message: 'الملف بلا أوراق' }], skippedEmpty: 0 }
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }) as unknown[][]
  const headerRowIndex = grid.findIndex((row) =>
    Array.isArray(row) && row.some((cell) => QUESTION_HEADERS.has(normHeader(cell))),
  )
  if (headerRowIndex < 0) {
    return { questions: [], errors: [{ row: 0, message: 'لم أجد صف عناوين — تأكد من تنزيل القالب أولاً' }], skippedEmpty: 0 }
  }
  const headers = (grid[headerRowIndex] as unknown[]).map((h) => String(h ?? ''))
  const qIdx = headerIndex(headers, QUESTION_HEADERS)
  const tIdx = headerIndex(headers, TYPE_HEADERS)
  const aIdx = headerIndex(headers, ANSWER_HEADERS)
  const eIdx = headerIndex(headers, EVIDENCE_HEADERS)
  const oIdx = OPTION_HEADERS.map((wanted) => headers.findIndex((h) => normHeader(h) === normHeader(wanted)))
  const questions: ComprehensiveQuestionInput[] = []
  const errors: Array<{ row: number; message: string }> = []
  let skippedEmpty = 0
  const rows = grid.slice(headerRowIndex + 1)
  if (rows.length > COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS) {
    errors.push({ row: 0, message: `الملف يحتوي ${rows.length} صفاً — الحد ${COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS} صفاً` })
  }
  for (let i = 0; i < Math.min(rows.length, COMPREHENSIVE_EXAM_IMPORT_MAX_ROWS); i++) {
    const row = rows[i] as unknown[]
    const rowNumber = headerRowIndex + 2 + i
    if (!Array.isArray(row) || row.every((c) => String(c ?? '').trim() === '')) {
      skippedEmpty++
      continue
    }
    const checked = validateComprehensiveQuestion({
      type: tIdx >= 0 ? row[tIdx] : 'MCQ',
      text: qIdx >= 0 ? row[qIdx] : '',
      options: oIdx.map((idx) => (idx >= 0 ? row[idx] : '')).filter((v) => String(v ?? '').trim() !== ''),
      correctAnswer: aIdx >= 0 ? row[aIdx] : '',
      sourceEvidence: eIdx >= 0 ? row[eIdx] : '',
    })
    if (!checked.ok) {
      errors.push({ row: rowNumber, message: checked.errors.join('؛ ') })
      continue
    }
    questions.push(checked.question)
  }
  return { questions, errors, skippedEmpty }
}

export function buildComprehensiveExamTemplateBuffer(): Buffer {
  const rows: unknown[][] = [
    ['السؤال', 'النوع', 'الخيار 1', 'الخيار 2', 'الخيار 3', 'الخيار 4', 'الإجابة الصحيحة', 'الدليل'],
    [
      'تُقاس الأصول المتداولة بأنها الموارد المتوقع تحويلها إلى نقد خلال دورة التشغيل العادية.',
      'صح/خطأ',
      '',
      '',
      '',
      '',
      'صح',
      'تعريف الأصول المتداولة في القوائم المالية.',
    ],
    [
      'أي مما يلي يُعد من الأصول المتداولة؟',
      'اختيار متعدد',
      'النقدية',
      'المباني',
      'براءات الاختراع',
      'الشهرة',
      '1',
      'النقدية أصل متداول.',
    ],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 60 }, { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 40 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'أسئلة الامتحان الشامل')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

// ---- Document (Word/PDF/TXT) draft import ----
// The extracted text is parsed as JSON (array or {"questions":[...]}) or
// as delimited rows (type, text, options…, correctAnswer, evidence) —
// the same row shape the question bank accepts for pasted imports.
// Anything unparsed is counted as skipped, never guessed.

export type ComprehensiveDocParseResult = {
  questions: ComprehensiveQuestionInput[]
  skipped: number
  errors: Array<{ row: number; message: string }>
}

export function parseComprehensiveExamDocText(value: unknown): ComprehensiveDocParseResult {
  const text = String(value || '').trim()
  if (!text) return { questions: [], skipped: 0, errors: [{ row: 0, message: 'المستند بلا نص مقروء' }] }
  let raw: unknown = null
  try {
    const parsed = JSON.parse(text)
    raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : null
  } catch {
    raw = null
  }
  const rows: unknown[] = raw !== null
    ? (raw as unknown[])
    : text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((line, i, all) => !(i === 0 && /type|question|text|السؤال|النوع/i.test(line) && all.length > 1))
        .map((line) => {
          const cols = line.split(/\t|;/).map((x) => x.trim())
          return {
            type: cols[0] || 'MCQ',
            text: cols[1] || cols[0],
            options: [cols[2], cols[3], cols[4], cols[5]].filter(Boolean),
            correctAnswer: cols[6] || '',
            sourceEvidence: cols[7] || '',
          }
        })
  const questions: ComprehensiveQuestionInput[] = []
  const errors: Array<{ row: number; message: string }> = []
  let skipped = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as any
    if (!r || typeof r !== 'object') {
      skipped++
      continue
    }
    const checked = validateComprehensiveQuestion(r)
    if (!checked.ok) {
      if (String(r.text || '').trim() === '') skipped++
      else errors.push({ row: i + 1, message: checked.errors.join('؛ ') })
      continue
    }
    questions.push(checked.question)
  }
  return { questions, skipped, errors }
}

// ---- Bank import mapping ----
// A bank item becomes a snapshot on the exam. Only MCQ/TF items are
// accepted — SHORT/ESSAY are refused, never converted.
export function toComprehensiveQuestionFromBankItem(
  item: { id: string; type: string; text: string; options: string | null; correctAnswer: string | null; sourceEvidence: string | null; bookId: string | null },
  order: number,
): { order: number; type: 'MCQ' | 'TF'; text: string; options: string | null; correctAnswer: string | null; source: 'BANK'; sourceBookId: string | null; sourceEvidence: string | null; bankItemId: string; status: 'APPROVED' } | null {
  if (item.type !== 'MCQ' && item.type !== 'TF') return null
  const checked = validateComprehensiveQuestion({
    type: item.type,
    text: item.text,
    options: item.options ? safeJsonArray(item.options) : [],
    correctAnswer: item.correctAnswer,
    correctAnswerIndexBase: 0,
    sourceEvidence: item.sourceEvidence,
  })
  if (!checked.ok) return null
  return {
    order,
    type: checked.question.type,
    text: checked.question.text,
    options: JSON.stringify(checked.question.options),
    correctAnswer: checked.question.correctAnswer,
    source: 'BANK',
    sourceBookId: item.bookId,
    sourceEvidence: checked.question.sourceEvidence ?? null,
    bankItemId: item.id,
    status: 'APPROVED',
  }
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
