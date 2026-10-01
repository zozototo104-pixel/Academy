import { db } from '@/lib/db'
import { formatAiKnowledgePolicyForPrompt, getAiKnowledgePolicy, type AiKnowledgeScope } from '@/lib/ai-knowledge-policy'

export type AiKnowledgeDiagnostics = {
  source: 'SCOPED_PROGRAM_CATALOG'
  scope: AiKnowledgeScope
  query: string
  totalPrograms: number
  matchedPrograms: number
  matchedProgramsWithBooks: number
  selectedPrograms: Array<{ titleAr?: string | null; titleEn?: string | null; category?: string | null; score: number; booksCount: number }>
  returnedReply: boolean
  reason?: string
}

export type ScopedProgramBooksResult = {
  reply: string | null
  diagnostics: AiKnowledgeDiagnostics
}

export type ProgramCatalogRecord = {
  titleAr?: string | null
  titleEn?: string | null
  category?: string | null
  active?: boolean | null
  hours?: number | string | null
  price?: number | string | null
  description?: string | null
  books?: Array<{ title?: string | null; titleEn?: string | null; author?: string | null; semester?: string | number | null; description?: string | null }>
  units?: Array<{ title?: string | null; semester?: string | number | null; status?: string | null; summary?: string | null }>
  assignments?: Array<{ title?: string | null; type?: string | null; semester?: string | number | null; points?: number | null }>
  programExams?: Array<{ title?: string | null; semester?: string | number | null; status?: string | null; passScore?: number | null; booksUsed?: string | null }>
  _count?: Record<string, number>
}

function compactText(value?: string | null, max = 240): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeArabic(value?: string | null): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function expandQuery(query?: string | null): string {
  const raw = String(query || '').toLowerCase()
  const n = normalizeArabic(query || '')
  const aliases = [n, raw]
  if (/(master|masters|maestr|maestría|maestria|mestrado|maestrado)/i.test(raw) || /ماجستير|مجستير|ماستر/.test(n)) {
    aliases.push('ماجستير مجستير ماستر الماجستير المهني master masters maestria maestría maestrado mestrado')
  }
  if (/(doctor|doctorate|phd|doctorado|doutorado)/i.test(raw) || /دكتوراه|دكتوراة|دكتورا|دكتور/.test(n)) {
    aliases.push('دكتوراه دكتوراة الدكتوراه المهنيه professional doctorate phd doctorado doutorado')
  }
  if (/business|administration|management|اداره|الاداره|اعمال|الاعمال/.test(`${raw} ${n}`)) aliases.push('ادارة اعمال اداره الاعمال business administration management')
  if (/book|books|bibliography|curriculum|syllabus|libros|livros|كتب|الكتب|كتاب|مراجع|منهاج|منهج|مواد|مقرره|مقررة/.test(`${raw} ${n}`)) aliases.push('كتب مراجع منهج منهاج مواد مقررة books curriculum syllabus bibliography')
  return aliases.join(' ')
}

function queryTokens(query?: string | null): string[] {
  return Array.from(new Set(expandQuery(query).split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 3))).slice(0, 80)
}

function programHaystack(program: ProgramCatalogRecord): string {
  return normalizeArabic([
    program.titleAr,
    program.titleEn,
    program.category,
    program.description,
    ...(program.books || []).flatMap((book) => [book.title, book.titleEn, book.author, book.description]),
    ...(program.units || []).flatMap((unit) => [unit.title, unit.summary, unit.status]),
    ...(program.assignments || []).map((assignment) => assignment.title),
    ...(program.programExams || []).flatMap((exam) => [exam.title, exam.booksUsed]),
  ].filter(Boolean).join(' '))
}

export function scoreProgramForQuery(program: ProgramCatalogRecord, query?: string | null): number {
  const tokens = queryTokens(query)
  if (!tokens.length) return 0
  const haystack = programHaystack(program)
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}

export function asksAboutProgramBooks(query?: string | null): boolean {
  const raw = String(query || '').toLowerCase()
  const n = normalizeArabic(query || '')
  const asksBooks = /book|books|bibliography|curriculum|syllabus|libros|livros/.test(raw) || ['كتب', 'الكتب', 'كتاب', 'مراجع', 'المراجع', 'منهاج', 'منهج', 'مواد', 'مقرره', 'مقررة', 'المقرره', 'المقررة'].some((x) => n.includes(x))
  const asksProgram = /program|degree|major|specialization|master|masters|maestr|mestrado|maestrado|doctor|doctorate|phd|diploma|bachelor/.test(raw) || ['برنامج', 'برامج', 'تخصص', 'تخصصات', 'ماجستير', 'مجستير', 'ماستر', 'دكتوراه', 'دكتوراة', 'دبلوم', 'بكالوريوس'].some((x) => n.includes(x))
  return asksBooks && asksProgram
}

export function formatProgramBooks(program: ProgramCatalogRecord): string {
  const books = Array.isArray(program.books) ? program.books : []
  if (!books.length) return 'لا توجد كتب مسجلة لهذا البرنامج في قاعدة البيانات.'
  return books.map((book, index) => {
    const title = book.title || book.titleEn || 'كتاب بلا عنوان'
    const titleEn = book.titleEn && book.titleEn !== title ? ` (${book.titleEn})` : ''
    const author = book.author ? ` — ${book.author}` : ''
    const semester = book.semester ? ` — فصل ${book.semester}` : ''
    const description = book.description ? ` — ${compactText(book.description, 140)}` : ''
    return `${index + 1}. «${title}»${titleEn}${author}${semester}${description}`
  }).join('\n')
}

export function formatProgramCatalogLine(program: ProgramCatalogRecord, index: number): string {
  const hours = program.hours ? ` — ${program.hours} ساعة` : ''
  const price = program.price ? ` — الرسوم ${program.price}$` : ''
  const status = program.active === false ? ' — غير نشط' : ''
  const units = program.units?.length
    ? `\nالوحدات/المواد: ${program.units.slice(0, 10).map((unit) => `${unit.title || 'وحدة بلا عنوان'}${unit.semester ? ` / فصل ${unit.semester}` : ''}`).join('، ')}`
    : ''
  const counts = program._count
    ? `\nعدادات المحتوى: كتب ${program._count.books ?? 0}، وحدات ${program._count.units ?? 0}، واجبات ${program._count.assignments ?? 0}، امتحانات ${program._count.programExams ?? 0}`
    : ''
  return `${index + 1}. ${program.titleAr || 'برنامج بلا عنوان'}${program.titleEn ? ` (${program.titleEn})` : ''} — ${program.category || 'تصنيف غير محدد'}${hours}${price}${status}\nالكتب/المراجع المسجلة حرفياً:\n${formatProgramBooks(program)}${units}${counts}`
}

async function loadProgramCatalog(limit = 140): Promise<ProgramCatalogRecord[]> {
  return (await db.program.findMany({
    where: { active: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: limit,
    select: {
      titleAr: true,
      titleEn: true,
      category: true,
      active: true,
      hours: true,
      price: true,
      description: true,
      books: {
        orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
        take: 30,
        select: { title: true, titleEn: true, author: true, semester: true, description: true },
      },
      units: {
        orderBy: [{ semester: 'asc' }, { order: 'asc' }],
        take: 14,
        select: { title: true, semester: true, status: true, summary: true },
      },
      assignments: {
        where: { status: 'PUBLISHED' },
        orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
        take: 8,
        select: { title: true, type: true, semester: true, points: true },
      },
      programExams: {
        orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
        take: 8,
        select: { title: true, semester: true, status: true, passScore: true, booksUsed: true },
      },
      _count: { select: { books: true, units: true, knowledgeItems: true, questionBankItems: true, assignments: true, programExams: true, enrollments: true } },
    },
  }).catch(() => [])) as ProgramCatalogRecord[]
}

export function rankProgramCatalog(programs: ProgramCatalogRecord[], query?: string | null): ProgramCatalogRecord[] {
  return programs
    .map((program) => ({ program, score: scoreProgramForQuery(program, query), hasBooks: (program.books || []).length > 0 }))
    .sort((a, b) => (b.score - a.score) || Number(b.hasBooks) - Number(a.hasBooks) || String(a.program.titleAr || '').localeCompare(String(b.program.titleAr || ''), 'ar'))
    .map((item) => item.program)
}

export async function buildScopedProgramCatalogSnapshot(options: { scope: AiKnowledgeScope; query?: string | null; limit?: number }): Promise<string> {
  const policy = getAiKnowledgePolicy(options.scope)
  if (!policy.canReadPublicCatalog) return ''
  const programs = await loadProgramCatalog(options.limit || 140)
  if (!programs.length) return ''
  const ranked = rankProgramCatalog(programs, options.query)
  const focused = ranked.filter((program) => scoreProgramForQuery(program, options.query) > 0).slice(0, 12)
  const list = focused.length ? focused : ranked.slice(0, 35)
  const lines = list.map((program, index) => formatProgramCatalogLine(program, index)).join('\n\n')
  return [
    formatAiKnowledgePolicyForPrompt(options.scope),
    'فهرس البرامج والكتب الرسمي من قاعدة بيانات المنصة. هذا هو مصدر الحقيقة لأسئلة الكتب، المراجع، المواد، الوحدات، التخصصات، الرسوم، وحالة البرنامج. لا تخترع كتباً أو مراجع غير ظاهرة هنا.',
    options.query ? `السؤال الحالي للمطابقة: ${compactText(options.query, 220)}` : '',
    lines,
  ].filter(Boolean).join('\n\n').slice(0, 32000)
}

export async function buildScopedKnowledgeContext(options: { scope: AiKnowledgeScope; query?: string | null }): Promise<string> {
  const catalog = await buildScopedProgramCatalogSnapshot({ scope: options.scope, query: options.query }).catch(() => '')
  return catalog || formatAiKnowledgePolicyForPrompt(options.scope)
}

export async function buildScopedDirectProgramBooksResult(query: string, scope: AiKnowledgeScope): Promise<ScopedProgramBooksResult> {
  const emptyDiagnostics = (reason: string): AiKnowledgeDiagnostics => ({
    source: 'SCOPED_PROGRAM_CATALOG',
    scope,
    query,
    totalPrograms: 0,
    matchedPrograms: 0,
    matchedProgramsWithBooks: 0,
    selectedPrograms: [],
    returnedReply: false,
    reason,
  })

  const policy = getAiKnowledgePolicy(scope)
  if (!policy.canReadProgramBooks) return { reply: null, diagnostics: emptyDiagnostics('scope_cannot_read_program_books') }
  if (!asksAboutProgramBooks(query)) return { reply: null, diagnostics: emptyDiagnostics('query_not_program_books') }

  const programs = await loadProgramCatalog(180)
  if (!programs.length) return { reply: null, diagnostics: emptyDiagnostics('no_active_programs_loaded') }

  const scored = programs.map((program) => ({ program, score: scoreProgramForQuery(program, query), hasBooks: (program.books || []).length > 0 }))
    .sort((a, b) => (b.score - a.score) || Number(b.hasBooks) - Number(a.hasBooks) || String(a.program.titleAr || '').localeCompare(String(b.program.titleAr || ''), 'ar'))
  const matched = scored.filter((item) => item.score > 0)
  const matchedWithBooks = matched.filter((item) => item.hasBooks)
  const selected = (matchedWithBooks.length ? matchedWithBooks : matched.length ? matched : scored.filter((item) => item.hasBooks)).slice(0, 10)

  const diagnosticsBase: AiKnowledgeDiagnostics = {
    source: 'SCOPED_PROGRAM_CATALOG',
    scope,
    query,
    totalPrograms: programs.length,
    matchedPrograms: matched.length,
    matchedProgramsWithBooks: matchedWithBooks.length,
    selectedPrograms: selected.map((item) => ({
      titleAr: item.program.titleAr,
      titleEn: item.program.titleEn,
      category: item.program.category,
      score: item.score,
      booksCount: item.program.books?.length || 0,
    })),
    returnedReply: false,
    reason: selected.length ? 'selected_programs_ready' : 'no_selected_programs_with_books_or_match',
  }

  if (!selected.length) {
    return {
      reply: 'حسب قاعدة بيانات المنصة الحالية، لا توجد كتب مسجلة لأي برنامج مطابق للسؤال.',
      diagnostics: { ...diagnosticsBase, returnedReply: true, reason: 'no_selected_programs' },
    }
  }

  const reply = [
    'حسب قاعدة بيانات المنصة الحالية، هذه الكتب/المراجع المسجلة للبرامج المطابقة لسؤالك:',
    '',
    selected.map((item, index) => formatProgramCatalogLine(item.program, index)).join('\n\n'),
    '',
    selected.some((item) => !(item.program.books || []).length) ? 'ملاحظة: أي برنامج ظاهر بلا كتب يعني أن قاعدة البيانات لا تحتوي كتباً مربوطة به حالياً.' : '',
  ].filter(Boolean).join('\n')

  return { reply, diagnostics: { ...diagnosticsBase, returnedReply: true } }
}

export async function buildScopedDirectProgramBooksReply(query: string, scope: AiKnowledgeScope): Promise<string | null> {
  const result = await buildScopedDirectProgramBooksResult(query, scope)
  return result.reply
}
