import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getProgramKnowledgeItems, rebuildKnowledgeForBook, rebuildProgramKnowledge, looksLikeBrokenAcademicOutput, KNOWLEDGE_BANK_LIMITS } from '@/lib/knowledge-bank'
import { scheduleProgramKnowledgeV2, enqueueKnowledgeAiRepairJob, getKnowledgeAiRepairJob } from '@/lib/book-knowledge-v2-scheduler'
import { planKnowledgeItemCleanup } from '@/lib/academic-output-quality'
import { withTimedResponse, withTiming } from '@/lib/timing'

export const runtime = 'nodejs'
export const maxDuration = 300

function categoryStats(items: { category: string; importance: number }[]) {
  const stats: Record<string, { count: number; avgImportance: number }> = {}
  for (const item of items) {
    const cur = stats[item.category] || { count: 0, avgImportance: 0 }
    cur.avgImportance += item.importance || 0
    cur.count++
    stats[item.category] = cur
  }
  for (const key of Object.keys(stats)) {
    stats[key].avgImportance = Math.round(stats[key].avgImportance / Math.max(1, stats[key].count))
  }
  return stats
}

// GET /api/admin/knowledge-bank?programId=xxx&semester=1
export async function GET(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    await withTiming('db_require_admin', () => requireAdmin())
    const programId = req.nextUrl.searchParams.get('programId') || ''
    const semRaw = req.nextUrl.searchParams.get('semester')
    const semester = semRaw ? Number(semRaw) || null : null
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    if (req.nextUrl.searchParams.get('repairStatus') === '1') {
      return NextResponse.json({ job: await getKnowledgeAiRepairJob(programId) }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const program = await withTiming('db_knowledge_bank_program', () => db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } }))
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    if (req.nextUrl.searchParams.get('review') === '1') {
      // Cursor-based review over the actual table: the normal 140/2000-item
      // preview deliberately hides suspect content and cannot be used as a queue.
      let cursor = String(req.nextUrl.searchParams.get('cursor') || '').slice(0, 100)
      const rowsForReview: Awaited<ReturnType<typeof db.bookKnowledgeItem.findMany>> = []
      let hasMore = false
      for (let scan = 0; scan < 4; scan++) {
        const rows = await db.bookKnowledgeItem.findMany({
          where: { programId, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 100,
        })
        if (!rows.length) { hasMore = false; break }
        cursor = rows[rows.length - 1].id
        rowsForReview.push(...rows.filter((row) =>
          planKnowledgeItemCleanup(row, looksLikeBrokenAcademicOutput).action === 'REVIEW' ||
          !row.bookId || !row.chunkId || row.pageStart == null || row.pageEnd == null
        ))
        hasMore = rows.length === 100
        if (rowsForReview.length >= 20 || !hasMore) break
      }
      const bookIds = [...new Set(rowsForReview.map((row) => row.bookId).filter((id): id is string => !!id))]
      const chunkIds = [...new Set(rowsForReview.map((row) => row.chunkId).filter((id): id is string => !!id))]
      const [books, chunks] = await Promise.all([
        db.book.findMany({ where: { id: { in: bookIds }, programId }, select: { id: true, title: true } }),
        db.bookChunk.findMany({ where: { id: { in: chunkIds }, programId }, select: { id: true, bookId: true, status: true, pageStart: true, pageEnd: true, text: true } }),
      ])
      const bookTitles = new Map(books.map((book) => [book.id, book.title]))
      const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
      const items = rowsForReview.map((row) => {
        const chunk = row.chunkId ? chunkById.get(row.chunkId) : null
        const sourceValid = !!(row.bookId && bookTitles.has(row.bookId) &&
          chunk && chunk.bookId === row.bookId && chunk.status === 'ANALYZED' &&
          row.pageStart != null && row.pageEnd != null &&
          row.pageStart >= chunk.pageStart && row.pageEnd <= chunk.pageEnd && row.pageStart <= row.pageEnd)
        return {
          id: row.id, programId: row.programId, title: row.title, summary: row.summary, excerpt: row.excerpt,
          bookTitle: row.bookId ? bookTitles.get(row.bookId) || null : null,
          pageStart: row.pageStart, pageEnd: row.pageEnd, updatedAt: row.updatedAt,
          reason: !sourceValid ? 'SOURCE_UNVERIFIED' : 'TEXT_UNRESOLVED',
          sourceValid, sourceTextPreview: sourceValid ? chunk!.text.slice(0, 6000) : null,
        }
      })
      return NextResponse.json({ items, nextCursor: hasMore ? cursor : null, hasMore }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const showAll = req.nextUrl.searchParams.get('all') === '1'
    const allItems = await withTiming('db_knowledge_bank_items', () => getProgramKnowledgeItems(programId, semester, showAll ? 2000 : 140))
    const items = showAll ? allItems : allItems.slice(0, 140)
    const total = await withTiming('db_knowledge_bank_total_count', () => db.bookKnowledgeItem.count({ where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) } }))
    const booksCount = await withTiming('db_knowledge_bank_books_count', () => db.book.count({ where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) } }))
    const v2BookCounts = await withTiming('db_knowledge_bank_v2_book_counts', () => db.bookKnowledgeItem.groupBy({
      by: ['bookId'],
      where: { programId, kbVersion: 2, bookId: { not: null }, category: { notIn: ['LEGACY', 'QUESTION_SEED'] } },
      _count: { _all: true },
    }))
    const v2CountsByBook = Object.fromEntries(v2BookCounts.filter((row) => row.bookId).map((row) => [row.bookId!, row._count._all]))
    const contextPreview = items.length
      ? items.slice(0, 16).map((item, i) => `${i + 1}. [${item.category}] ${item.title}: ${item.summary.slice(0, 320)}${item.bookTitle ? ` — المصدر: ${item.bookTitle}` : ''}`).join('\n')
      : ''
    return NextResponse.json({
      program,
      booksCount,
      v2CountsByBook,
      count: allItems.length,
      total,
      displayedCount: items.length,
      limits: KNOWLEDGE_BANK_LIMITS,
      stats: categoryStats(items),
      items,
      contextPreview,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('knowledge-bank GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل بنك المعرفة' }, { status: 500 })
  }
  })
}

// POST /api/admin/knowledge-bank — action: rebuild | rebuild-book
export async function POST(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    const admin = await withTiming('db_require_admin', () => requireAdmin())
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || 'rebuild').trim()
    const programId = String(body.programId || '').trim()
    const bookId = String(body.bookId || '').trim()
    const semRaw = body.semester
    const semester = semRaw ? Number(semRaw) || null : null

    if (action === 'repair-ai') {
      if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
      const program = await db.program.findUnique({ where: { id: programId }, select: { id: true } })
      if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
      // Only enqueue. The cron performs strictly budgeted AI calls after this
      // response; closing the browser cannot interrupt the persisted job.
      const job = await enqueueKnowledgeAiRepairJob(programId)
      return NextResponse.json({ ok: true, queued: true, job }, { status: 202 })
    }

    if (action === 'sanitize' || action === 'clean') {
      if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
      let deleted = 0
      let updated = 0
      let needsReview = 0
      let unchanged = 0
      let cursor: string | undefined
      while (true) {
        const rows = await withTiming('db_knowledge_bank_sanitize_page', () => db.bookKnowledgeItem.findMany({ where: { programId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 500 }))
        if (!rows.length) break
        cursor = rows[rows.length - 1].id
        const deleteIds: string[] = []
        const updates: Promise<any>[] = []
        for (const row of rows) {
          const plan = planKnowledgeItemCleanup(row, looksLikeBrokenAcademicOutput)
          if (plan.action === 'DELETE_EMPTY') {
            deleteIds.push(row.id)
          } else if (plan.action === 'UPDATE') {
            updates.push(withTiming('db_knowledge_bank_sanitize_update', () => db.bookKnowledgeItem.update({ where: { id: row.id }, data: plan.data })))
          } else if (plan.action === 'REVIEW') {
            // Keep the entire source-linked record unchanged: never commit an
            // incomplete correction or drop an academic guide's source ID.
            needsReview++
          } else {
            unchanged++
          }
        }
        if (deleteIds.length) { const result = await withTiming('db_knowledge_bank_sanitize_delete_many', () => db.bookKnowledgeItem.deleteMany({ where: { id: { in: deleteIds } } })); deleted += result.count }
        if (updates.length) { await Promise.all(updates); updated += updates.length }
        if (rows.length < 500) break
      }
      await withTiming('db_audit_knowledge_bank_sanitize', () => audit(admin, 'SANITIZE_KNOWLEDGE_BANK', 'Program', programId, `تصحيح بنك المعرفة: تحديث ${updated} عنصر كامل، حذف ${deleted} عنصر فارغ بالكامل، إبقاء ${needsReview} عنصر يحتاج مراجعة دون تعديل جزئي`))
      const items = await withTiming('db_knowledge_bank_items_after_sanitize', () => getProgramKnowledgeItems(programId, semester, 140))
      const message = needsReview > 0 ? `بقي ${needsReview} عنصر يحتاج مراجعة؛ لم يُحذف أو يُعدّل جزئياً` : null
      return NextResponse.json({ ok: true, deleted, updated, needsReview, unchanged, rebuilt: null, message, count: items.length, stats: categoryStats(items), items })
    }

    if (action === 'rebuild-book' || action === 'read-book-full') {
      if (!bookId) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })
      const strictFullRead = action === 'read-book-full' || body.strictFullRead === true
      let result
      try {
        result = await withTiming('db_knowledge_bank_rebuild_book', () => rebuildKnowledgeForBook(bookId, { strictFullRead }))
      } catch (e: any) {
        if (e?.code !== 'AI_ACADEMIC_PROVIDER_UNAVAILABLE') throw e
        const paused = { code: e.code, reason: String(e?.message || e).slice(0, 500), retryAt: e?.retryAt || null, pausedAt: new Date().toISOString() }
        await withTiming('db_knowledge_bank_pause_upsert', () => db.setting.upsert({
          where: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}` },
          create: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}`, value: JSON.stringify(paused) },
          update: { value: JSON.stringify(paused) },
        }).catch(() => {}))
        return NextResponse.json({ error: 'توقف تحليل الكتاب مؤقتاً لأن المزود الأكاديمي غير متاح. يمكن استئنافه لاحقاً من نفس زر القراءة الكاملة.', status: 'PAUSED', ...paused }, { status: 503 })
      }
      await withTiming('db_knowledge_bank_pause_delete', () => db.setting.delete({ where: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}` } }).catch(() => {}))
      await withTiming('db_audit_knowledge_bank_book', () => audit(admin, strictFullRead ? 'READ_FULL_BOOK_KNOWLEDGE' : 'REBUILD_BOOK_KNOWLEDGE', 'Book', bookId, `${strictFullRead ? 'قراءة وتحليل كامل للكتاب' : 'بناء'} ${result.inserted} عنصر معرفة من كتاب واحد`))
      const items = await withTiming('db_knowledge_bank_items_after_book', () => getProgramKnowledgeItems(result.programId, semester, 140))
      return NextResponse.json({ ok: true, strictFullRead, result, count: items.length, stats: categoryStats(items), items })
    }

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    // The program-wide rebuild button schedules v2 jobs; the legacy v1 builder stays available for other paths.
    const result = await withTiming('db_knowledge_bank_schedule_v2', () => scheduleProgramKnowledgeV2(programId, semester))
    await withTiming('db_audit_knowledge_bank_schedule', () => audit(admin, 'SCHEDULE_PROGRAM_KNOWLEDGE_V2', 'Program', programId, `جدولة/استكمال ${result.results.length} كتاب عبر v2`))
    const items = await withTiming('db_knowledge_bank_items_after_schedule', () => getProgramKnowledgeItems(programId, semester, 140))
    return NextResponse.json({ ok: true, result, count: items.length, stats: categoryStats(items), items })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('knowledge-bank POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر بناء بنك المعرفة' }, { status: 500 })
  }
  })
}
