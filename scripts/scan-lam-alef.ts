import { db } from '@/lib/db'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'

// Diagnostic-only scan; this script must never write to the database.
type Example = {
  source: string
  id: string
  locator: string
  field: string
  pattern: string
  excerpt: string
}

type TextField = readonly [field: string, value: string | null | undefined]

const WORD_BOUNDARY = '[^\u0621-\u064A\u0660-\u0669\u06F0-\u06F9A-Za-z0-9_]'

const suspiciousPatterns: Array<{ label: string; re: RegExp }> = [
  { label: 'بال حدود', re: / بال حدود/g },
  { label: 'إال', re: /إال/g },
  { label: 'اال', re: /اال/g },
  { label: 'األ', re: /األ/g },
  { label: 'اإل', re: /اإل/g },
  { label: 'اآل', re: /اآل/g },
  { label: 'ال بد', re: / ال بد/g },
  { label: 'كلمة مستقلة ال', re: new RegExp(`(^|${WORD_BOUNDARY})ال(?=$|${WORD_BOUNDARY})`, 'gu') },
  { label: 'Arabic Presentation Forms U+FB50..U+FEFF', re: /[\uFB50-\uFEFF]/g },
]

const dryRun = process.argv.includes('--dry-run')

function excerpt(text: string, index: number, length: number) {
  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + length + 30)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

function patternCounts(text: string) {
  const counts: Record<string, number> = {}
  for (const pattern of suspiciousPatterns) {
    pattern.re.lastIndex = 0
    counts[pattern.label] = [...String(text || '').matchAll(pattern.re)].length
  }
  return counts
}

function totalCount(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

function addCounts(target: Record<string, number>, counts: Record<string, number>) {
  for (const [key, value] of Object.entries(counts)) target[key] = (target[key] || 0) + value
}

function addTextScan(target: Record<string, number>, value: unknown) {
  if (typeof value === 'string' && value) addCounts(target, patternCounts(value))
}

function addDryRunScan(target: Record<string, number>, value: unknown) {
  if (typeof value === 'string' && value) addCounts(target, patternCounts(fixArabicPdfText(value)))
}

function findTextExamples(args: { source: string; id: string; locator: string; field: string; text: string }, limit = 5): Example[] {
  const examples: Example[] = []
  for (const pattern of suspiciousPatterns) {
    pattern.re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.re.exec(args.text)) && examples.length < limit) {
      examples.push({
        source: args.source,
        id: args.id,
        locator: args.locator,
        field: args.field,
        pattern: pattern.label,
        excerpt: excerpt(args.text, match.index, match[0].length),
      })
    }
    if (examples.length >= limit) break
  }
  return examples
}

function isAffectedText(text: string) {
  return totalCount(patternCounts(text)) > 0
}

function fixedText(value: string | null | undefined) {
  if (value == null) return value
  return fixArabicPdfText(value)
}

function scanOptionsJson(value: string | null | undefined, totals: Record<string, number>, dryTotals?: Record<string, number>) {
  if (!value) return { before: 0, after: 0 }
  let before = 0
  let after = 0
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item !== 'string') continue
        const beforeCount = totalCount(patternCounts(item))
        const afterCount = totalCount(patternCounts(fixArabicPdfText(item)))
        before += beforeCount
        after += afterCount
        addTextScan(totals, item)
        if (dryTotals) addDryRunScan(dryTotals, item)
      }
      return { before, after }
    }
  } catch {
    // Fall back to scanning the raw legacy options string.
  }
  before = totalCount(patternCounts(value))
  after = totalCount(patternCounts(fixArabicPdfText(value)))
  addTextScan(totals, value)
  if (dryTotals) addDryRunScan(dryTotals, value)
  return { before, after }
}

function scanFields(args: { source: string; id: string; locator: string; fields: readonly TextField[]; examples: Example[]; beforeTotals: Record<string, number>; afterTotals: Record<string, number> }) {
  let affected = false
  let before = 0
  let after = 0
  for (const [field, value] of args.fields) {
    addTextScan(args.beforeTotals, value)
    if (dryRun) addDryRunScan(args.afterTotals, value)
    if (typeof value !== 'string') continue
    const beforeCount = totalCount(patternCounts(value))
    const afterCount = totalCount(patternCounts(fixArabicPdfText(value)))
    before += beforeCount
    after += afterCount
    if (beforeCount > 0) {
      affected = true
      if (args.examples.length < 5) args.examples.push(...findTextExamples({ source: args.source, id: args.id, locator: args.locator, field, text: value }, 5 - args.examples.length))
    }
  }
  return { affected, before, after }
}

async function main() {
  console.log(`mode=${dryRun ? 'DRY_RUN_FIX_PREVIEW' : 'SCAN_ONLY'}`)
  const books = await db.book.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, programId: true },
  })
  let affectedBooks = 0
  let totalAffectedChunks = 0
  let totalAffectedKnowledgeItems = 0
  let totalAffectedQuestions = 0
  let totalAffectedExamQuestions = 0
  let totalAffectedUnits = 0
  let totalAffectedStudyGuides = 0
  const beforeTotals: Record<string, number> = {}
  const afterTotals: Record<string, number> = {}

  for (const book of books) {
    const [chunks, knowledgeItems, bankQuestions, units] = await Promise.all([
      db.bookChunk.findMany({ where: { bookId: book.id }, orderBy: { index: 'asc' }, select: { id: true, index: true, pageStart: true, pageEnd: true, text: true } }),
      db.bookKnowledgeItem.findMany({ where: { bookId: book.id }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, summary: true, excerpt: true, keywords: true, sourceNote: true, textProvenance: true, pageStart: true, pageEnd: true } }),
      db.questionBankItem.findMany({ where: { bookId: book.id }, orderBy: { createdAt: 'asc' }, select: { id: true, text: true, options: true, modelAnswer: true, sourceEvidence: true, type: true } }),
      db.unit.findMany({ where: { sourceBookId: book.id }, orderBy: { order: 'asc' }, select: { id: true, title: true, summary: true, content: true, objectives: true, order: true } }),
    ])
    const unitIds = units.map((unit) => unit.id)
    const [studyGuides, exams] = await Promise.all([
      unitIds.length ? db.programStudyGuide.findMany({ where: { unitId: { in: unitIds } }, orderBy: { updatedAt: 'desc' }, select: { id: true, unitId: true, title: true, overview: true, objectives: true, keyTerms: true, sections: true, activities: true, discussionQuestions: true } }) : [],
      unitIds.length ? db.exam.findMany({ where: { unitId: { in: unitIds } }, select: { id: true, unitId: true } }) : [],
    ])
    const examIds = exams.map((exam) => exam.id)
    const examQuestions = examIds.length
      ? await db.question.findMany({ where: { examId: { in: examIds } }, orderBy: { order: 'asc' }, select: { id: true, examId: true, order: true, type: true, text: true, options: true, modelAnswer: true } })
      : []

    const examples: Example[] = []
    let bookAffectedChunks = 0
    let bookAffectedKnowledgeItems = 0
    let bookAffectedQuestions = 0
    let bookAffectedExamQuestions = 0
    let bookAffectedUnits = 0
    let bookAffectedStudyGuides = 0
    const before = { chunks: 0, knowledgeItems: 0, questions: 0, examQuestions: 0, units: 0, studyGuides: 0 }
    const after = { chunks: 0, knowledgeItems: 0, questions: 0, examQuestions: 0, units: 0, studyGuides: 0 }

    for (const chunk of chunks) {
      const scan = scanFields({ source: 'BookChunk', id: chunk.id, locator: `chunk=${chunk.index} pages=${chunk.pageStart}-${chunk.pageEnd}`, fields: [['text', chunk.text]], examples, beforeTotals, afterTotals })
      before.chunks += scan.before
      after.chunks += scan.after
      if (scan.affected) bookAffectedChunks += 1
    }

    for (const item of knowledgeItems) {
      const scan = scanFields({
        source: 'BookKnowledgeItem',
        id: item.id,
        locator: `pages=${item.pageStart ?? '?'}-${item.pageEnd ?? '?'}`,
        fields: [['title', item.title], ['summary', item.summary], ['excerpt', item.excerpt], ['keywords', item.keywords], ['sourceNote', item.sourceNote], ['textProvenance', item.textProvenance]],
        examples,
        beforeTotals,
        afterTotals,
      })
      before.knowledgeItems += scan.before
      after.knowledgeItems += scan.after
      if (scan.affected) bookAffectedKnowledgeItems += 1
    }

    for (const question of bankQuestions) {
      const scan = scanFields({
        source: 'QuestionBankItem',
        id: question.id,
        locator: `type=${question.type}`,
        fields: [['text', question.text], ['modelAnswer', question.modelAnswer], ['sourceEvidence', question.sourceEvidence]],
        examples,
        beforeTotals,
        afterTotals,
      })
      const optionScan = scanOptionsJson(question.options, beforeTotals, dryRun ? afterTotals : undefined)
      before.questions += scan.before + optionScan.before
      after.questions += scan.after + optionScan.after
      if (scan.affected || optionScan.before > 0) bookAffectedQuestions += 1
    }

    for (const unit of units) {
      const scan = scanFields({
        source: 'Unit',
        id: unit.id,
        locator: `order=${unit.order}`,
        fields: [['title', unit.title], ['summary', unit.summary], ['content', unit.content], ['objectives', unit.objectives]],
        examples,
        beforeTotals,
        afterTotals,
      })
      before.units += scan.before
      after.units += scan.after
      if (scan.affected) bookAffectedUnits += 1
    }

    for (const guide of studyGuides) {
      const scan = scanFields({
        source: 'ProgramStudyGuide',
        id: guide.id,
        locator: `unit=${guide.unitId}`,
        fields: [['title', guide.title], ['overview', guide.overview], ['objectives', guide.objectives], ['keyTerms', guide.keyTerms], ['sections', guide.sections], ['activities', guide.activities], ['discussionQuestions', guide.discussionQuestions]],
        examples,
        beforeTotals,
        afterTotals,
      })
      before.studyGuides += scan.before
      after.studyGuides += scan.after
      if (scan.affected) bookAffectedStudyGuides += 1
    }

    for (const question of examQuestions) {
      const scan = scanFields({
        source: 'Question',
        id: question.id,
        locator: `exam=${question.examId} order=${question.order} type=${question.type}`,
        fields: [['text', question.text], ['modelAnswer', question.modelAnswer]],
        examples,
        beforeTotals,
        afterTotals,
      })
      const optionScan = scanOptionsJson(question.options, beforeTotals, dryRun ? afterTotals : undefined)
      before.examQuestions += scan.before + optionScan.before
      after.examQuestions += scan.after + optionScan.after
      if (scan.affected || optionScan.before > 0) bookAffectedExamQuestions += 1
    }

    const affected = bookAffectedChunks + bookAffectedKnowledgeItems + bookAffectedQuestions + bookAffectedExamQuestions + bookAffectedUnits + bookAffectedStudyGuides
    if (!affected) continue
    affectedBooks += 1
    totalAffectedChunks += bookAffectedChunks
    totalAffectedKnowledgeItems += bookAffectedKnowledgeItems
    totalAffectedQuestions += bookAffectedQuestions
    totalAffectedExamQuestions += bookAffectedExamQuestions
    totalAffectedUnits += bookAffectedUnits
    totalAffectedStudyGuides += bookAffectedStudyGuides
    console.log(`\nBOOK ${book.id} | ${book.title} | program=${book.programId}`)
    console.log(`affectedChunks=${bookAffectedChunks}/${chunks.length}`)
    console.log(`affectedKnowledgeItems=${bookAffectedKnowledgeItems}/${knowledgeItems.length}`)
    console.log(`affectedQuestions=${bookAffectedQuestions}/${bankQuestions.length}`)
    console.log(`affectedExamQuestions=${bookAffectedExamQuestions}/${examQuestions.length}`)
    console.log(`affectedUnits=${bookAffectedUnits}/${units.length}`)
    console.log(`affectedStudyGuides=${bookAffectedStudyGuides}/${studyGuides.length}`)
    if (dryRun) {
      console.log(`dryRunSuspiciousPatternsBefore=${JSON.stringify(before)}`)
      console.log(`dryRunSuspiciousPatternsAfter=${JSON.stringify(after)}`)
    }
    for (const item of examples.slice(0, 5)) {
      console.log(`- ${item.source} id=${item.id} ${item.locator} field=${item.field} pattern=${item.pattern}`)
      console.log(`  ${item.excerpt}`)
    }
  }
  console.log('\nSUMMARY')
  console.log(`booksScanned=${books.length}`)
  console.log(`affectedBooks=${affectedBooks}`)
  console.log(`affectedChunks=${totalAffectedChunks}`)
  console.log(`affectedKnowledgeItems=${totalAffectedKnowledgeItems}`)
  console.log(`affectedQuestions=${totalAffectedQuestions}`)
  console.log(`affectedExamQuestions=${totalAffectedExamQuestions}`)
  console.log(`affectedUnits=${totalAffectedUnits}`)
  console.log(`affectedStudyGuides=${totalAffectedStudyGuides}`)
  console.log(`patternsBefore=${JSON.stringify(beforeTotals)}`)
  if (dryRun) console.log(`patternsAfterDryRun=${JSON.stringify(afterTotals)}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
