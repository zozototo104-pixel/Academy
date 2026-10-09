import { db } from '@/lib/db'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'

// Diagnostic-only scan; this script must never write to the database.
type Example = {
  chunkId: string
  index: number
  pageStart: number
  pageEnd: number
  pattern: string
  excerpt: string
}

const suspiciousPatterns: Array<{ label: string; re: RegExp }> = [
  { label: 'بال حدود', re: / بال حدود/g },
  { label: 'إال', re: /إال/g },
  { label: 'اال', re: /اال/g },
  { label: 'ال بد', re: / ال بد/g },
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
    counts[pattern.label] = [...text.matchAll(pattern.re)].length
  }
  return counts
}

function totalCount(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

function addCounts(target: Record<string, number>, counts: Record<string, number>) {
  for (const [key, value] of Object.entries(counts)) target[key] = (target[key] || 0) + value
}

function findExamples(chunk: { id: string; index: number; pageStart: number; pageEnd: number; text: string }, limit = 5): Example[] {
  const examples: Example[] = []
  for (const pattern of suspiciousPatterns) {
    pattern.re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.re.exec(chunk.text)) && examples.length < limit) {
      examples.push({
        chunkId: chunk.id,
        index: chunk.index,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        pattern: pattern.label,
        excerpt: excerpt(chunk.text, match.index, match[0].length),
      })
    }
    if (examples.length >= limit) break
  }
  return examples
}

function isAffected(text: string) {
  return totalCount(patternCounts(text)) > 0
}

async function main() {
  console.log(`mode=${dryRun ? 'DRY_RUN_FIX_PREVIEW' : 'SCAN_ONLY'}`)
  const books = await db.book.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, programId: true },
  })
  let totalAffectedChunks = 0
  let affectedBooks = 0
  const beforeTotals: Record<string, number> = {}
  const afterTotals: Record<string, number> = {}
  for (const book of books) {
    const chunks = await db.bookChunk.findMany({
      where: { bookId: book.id },
      orderBy: { index: 'asc' },
      select: { id: true, index: true, pageStart: true, pageEnd: true, text: true },
    })
    const affected = chunks.filter((chunk) => isAffected(chunk.text))
    for (const chunk of chunks) {
      addCounts(beforeTotals, patternCounts(chunk.text))
      if (dryRun) addCounts(afterTotals, patternCounts(fixArabicPdfText(chunk.text)))
    }
    if (!affected.length) continue
    affectedBooks += 1
    totalAffectedChunks += affected.length
    const examples = affected.flatMap((chunk) => findExamples(chunk, 5)).slice(0, 5)
    console.log(`\nBOOK ${book.id} | ${book.title} | program=${book.programId}`)
    console.log(`affectedChunks=${affected.length}/${chunks.length}`)
    if (dryRun) {
      const before = affected.reduce((sum, chunk) => sum + totalCount(patternCounts(chunk.text)), 0)
      const after = affected.reduce((sum, chunk) => sum + totalCount(patternCounts(fixArabicPdfText(chunk.text))), 0)
      console.log(`dryRunSuspiciousPatternsBefore=${before}`)
      console.log(`dryRunSuspiciousPatternsAfter=${after}`)
    }
    for (const item of examples) {
      console.log(`- chunk=${item.index} pages=${item.pageStart}-${item.pageEnd} pattern=${item.pattern}`)
      console.log(`  ${item.excerpt}`)
    }
  }
  console.log('\nSUMMARY')
  console.log(`booksScanned=${books.length}`)
  console.log(`affectedBooks=${affectedBooks}`)
  console.log(`affectedChunks=${totalAffectedChunks}`)
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
