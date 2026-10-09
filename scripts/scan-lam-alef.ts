import { db } from '@/lib/db'

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

function excerpt(text: string, index: number, length: number) {
  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + length + 30)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
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
  return suspiciousPatterns.some((pattern) => {
    pattern.re.lastIndex = 0
    return pattern.re.test(text)
  })
}

async function main() {
  const books = await db.book.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, programId: true },
  })
  let totalAffectedChunks = 0
  let affectedBooks = 0
  for (const book of books) {
    const chunks = await db.bookChunk.findMany({
      where: { bookId: book.id },
      orderBy: { index: 'asc' },
      select: { id: true, index: true, pageStart: true, pageEnd: true, text: true },
    })
    const affected = chunks.filter((chunk) => isAffected(chunk.text))
    if (!affected.length) continue
    affectedBooks += 1
    totalAffectedChunks += affected.length
    const examples = affected.flatMap((chunk) => findExamples(chunk, 5)).slice(0, 5)
    console.log(`\nBOOK ${book.id} | ${book.title} | program=${book.programId}`)
    console.log(`affectedChunks=${affected.length}/${chunks.length}`)
    for (const item of examples) {
      console.log(`- chunk=${item.index} pages=${item.pageStart}-${item.pageEnd} pattern=${item.pattern}`)
      console.log(`  ${item.excerpt}`)
    }
  }
  console.log('\nSUMMARY')
  console.log(`booksScanned=${books.length}`)
  console.log(`affectedBooks=${affectedBooks}`)
  console.log(`affectedChunks=${totalAffectedChunks}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
