import { db } from '@/lib/db'

/** Preserve the existing program/semester scope. Never invokes the legacy v1 builder. */
export async function scheduleProgramKnowledgeV2(programId: string, semester?: number | null) {
  const books = await db.book.findMany({
    where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) },
    orderBy: { createdAt: 'asc' }, select: { id: true, title: true },
  })
  if (!books.length) throw new Error('لا توجد كتب مقررة لبناء بنك المعرفة')
  const results: { bookId: string; title: string; state: 'READING' | 'ENRICHING' | 'COMPLETED' | 'PAUSED'; jobId?: string; retryAt?: Date | null }[] = []
  for (const book of books) {
    const active = await db.bookReadJob.findFirst({ where: { bookId: book.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (active) {
      results.push({ bookId: book.id, title: book.title, state: active.status === 'PAUSED' ? 'PAUSED' : active.phase === 'ENRICH' ? 'ENRICHING' : 'READING', jobId: active.id, retryAt: active.retryAt })
      continue
    }
    const chunks = await db.bookChunk.count({ where: { bookId: book.id } })
    const pending = await db.bookChunk.count({ where: { bookId: book.id, status: { in: ['PENDING', 'EXTRACTED', 'FAILED'] } } })
    const remaining = await db.bookChunk.count({ where: { bookId: book.id, status: 'ANALYZED', saturatedAt: null, analysisPasses: { lt: 3 } } })
    // Fully analyzed books with no accepted v2 knowledge still qualify for enrichment.
    const mode = !chunks || pending ? 'EXTRACT' : remaining ? 'ENRICH' : null
    if (!mode) { results.push({ bookId: book.id, title: book.title, state: 'COMPLETED' }); continue }
    let job
    try {
      job = await db.bookReadJob.create({ data: { bookId: book.id, programId, phase: mode, status: 'QUEUED' } })
    } catch (error: any) {
      if (error?.code !== 'P2002' && error?.code !== '23505') throw error
      job = await db.bookReadJob.findFirst({ where: { bookId: book.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
      if (!job) throw error
    }
    results.push({ bookId: book.id, title: book.title, state: job.status === 'PAUSED' ? 'PAUSED' : job.phase === 'ENRICH' ? 'ENRICHING' : 'READING', jobId: job.id, retryAt: job.retryAt })
  }
  return { programId, results }
}
