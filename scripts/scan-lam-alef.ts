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

function scanOptionsJson(value: string | null | undefined, totals: Record<string, number>, dryTotals?: Record<string, number>) {
  if (!value) return
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        addTextScan(totals, item)
        if (dryTotals) addDryRunScan(dryTotals, item)
      }
      return
    }
  } catch {
    // Fall back to scanning the raw legacy options string.
  }
  addTextScan(totals, value)
  if (dryTotals) addDryRunScan(dryTotals, value)
}

async function main() {
  console.log(`mode=${dryRun ? 'DRY_RUN_FIX_PREVIEW' : 'SCAN_ONLY'}`)
  const books = await db.book.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, programId: true },
  })
  let totalAffectedChunks = 0
  let totalAffectedKnowledgeItems = 0
  let totalAffectedQuestions = 0
  let affectedBooks = 0
  const beforeTotals: Record<string, number> = {}
  const afterTotals: Record<string, number> = {}
  for (const book of books) {
    const [chunks, knowledgeItems, questions] = await Promise.all([
      db.bookChunk.findMany({
        where: { bookId: book.id },
        orderBy: { index: 'asc' },
        select: { id: true, index: true, pageStart: true, pageEnd: true, text: true },
      }),
      db.bookKnowledgeItem.findMany({
        where: { bookId: book.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, summary: true, excerpt: true, keywords: true, sourceNote: true, textProvenance: true, pageStart: true, pageEnd: true },
      }),
      db.questionBankItem.findMany({
        where: { bookId: book.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, text: true, options: true, modelAnswer: true, sourceEvidence: true, sourceLocator: true, type: true },
      }),
    ])

    const examples: Example[] = []
    let bookAffectedChunks = 0
    let bookAffectedKnowledgeItems = 0
    let bookAffectedQuestions = 0

    for (const chunk of chunks) {
      addTextScan(beforeTotals, chunk.text)
      if (dryRun) addDryRunScan(afterTotals, chunk.text)
      if (!isAffectedText(chunk.text)) continue
      bookAffectedChunks += 1
      if (examples.length < 5) examples.push(...findTextExamples({ source: 'BookChunk', id: chunk.id, locator: `chunk=${chunk.index} pages=${chunk.pageStart}-${chunk.pageEnd}`, field: 'text', text: chunk.text }, 5 - examples.length))
    }

    for (const item of knowledgeItems) {
      const fields = [
        ['title', item.title],
        ['summary', item.summary],
        ['excerpt', item.excerpt],
        ['keywords', item.keywords],
        ['sourceNote', item.sourceNote],
        ['textProvenance', item.textProvenance],
      ] as const
      let affected = false
      for (const [field, value] of fields) {
        addTextScan(beforeTotals, value)
        if (dryRun) addDryRunScan(afterTotals, value)
        if (typeof value === 'string' && isAffectedText(value)) {
          affected = true
          if (examples.length < 5) examples.push(...findTextExamples({ source: 'BookKnowledgeItem', id: item.id, locator: `pages=${item.pageStart ?? '?'}-${item.pageEnd ?? '?'}`, field, text: value }, 5 - examples.length))
        }
      }
      if (affected) bookAffectedKnowledgeItems += 1
    }

    for (const question of questions) {
      const fields = [
        ['text', question.text],
        ['modelAnswer', question.modelAnswer],
        ['sourceEvidence', question.sourceEvidence],
        ['sourceLocator', question.sourceLocator],
      ] as const
      let affected = false
      for (const [field, value] of fields) {
        addTextScan(beforeTotals, value)
        if (dryRun) addDryRunScan(afterTotals, value)
        if (typeof value === 'string' && isAffectedText(value)) {
          affected = true
          if (examples.length < 5) examples.push(...findTextExamples({ source: 'QuestionBankItem', id: question.id, locator: `type=${question.type}`, field, text: value }, 5 - examples.length))
        }
      }
      const beforeOptions = totalCount(patternCounts(question.options || ''))
      scanOptionsJson(question.options, beforeTotals, dryRun ? afterTotals : undefined)
      if (beforeOptions > 0) affected = true
      if (affected) bookAffectedQuestions += 1
    }

    const affected = bookAffectedChunks + bookAffectedKnowledgeItems + bookAffectedQuestions
    if (!affected) continue
    affectedBooks += 1
    totalAffectedChunks += bookAffectedChunks
    totalAffectedKnowledgeItems += bookAffectedKnowledgeItems
    totalAffectedQuestions += bookAffectedQuestions
    console.log(`\nBOOK ${book.id} | ${book.title} | program=${book.programId}`)
    console.log(`affectedChunks=${bookAffectedChunks}/${chunks.length}`)
    console.log(`affectedKnowledgeItems=${bookAffectedKnowledgeItems}/${knowledgeItems.length}`)
    console.log(`affectedQuestions=${bookAffectedQuestions}/${questions.length}`)
    if (dryRun) {
      const before = { chunks: 0, knowledgeItems: 0, questions: 0 }
      const after = { chunks: 0, knowledgeItems: 0, questions: 0 }
      for (const chunk of chunks) { before.chunks += totalCount(patternCounts(chunk.text)); after.chunks += totalCount(patternCounts(fixArabicPdfText(chunk.text))) }
      for (const item of knowledgeItems) {
        for (const value of [item.title, item.summary, item.excerpt, item.keywords, item.sourceNote, item.textProvenance]) {
          before.knowledgeItems += typeof value === 'string' ? totalCount(patternCounts(value)) : 0
          after.knowledgeItems += typeof value === 'string' ? totalCount(patternCounts(fixArabicPdfText(value))) : 0
        }
      }
      for (const question of questions) {
        for (const value of [question.text, question.modelAnswer, question.sourceEvidence, question.sourceLocator, question.options]) {
          before.questions += typeof value === 'string' ? totalCount(patternCounts(value)) : 0
          after.questions += typeof value === 'string' ? totalCount(patternCounts(fixArabicPdfText(value))) : 0
        }
      }
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
