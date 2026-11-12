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

    if (req.nextUrl.searchParams.get('sourceCandidates') === '1') {
      // Read-only recovery assistance. Search ONLY the item's own book.
      // A matching 60-character prefix is a hint, not verified provenance;
      // even a full-text hit does not assign an exact PDF page automatically.
      const itemId = String(req.nextUrl.searchParams.get('itemId') || '').slice(0, 100)
      if (!itemId) return NextResponse.json({ error: 'معرف عنصر المعرفة مطلوب' }, { status: 400 })
      const item = await db.bookKnowledgeItem.findFirst({ where: { id: itemId, programId } })
      if (!item) return NextResponse.json({ error: 'عنصر المعرفة غير موجود في البرنامج' }, { status: 404 })
      if (!item.bookId) return NextResponse.json({ candidates: [], examinedChunks: 0, truncated: false, reason: 'NO_BOOK' })
      const book = await db.book.findFirst({
        where: { id: item.bookId, programId }, select: { id: true, title: true },
      })
      if (!book) return NextResponse.json({ candidates: [], examinedChunks: 0, truncated: false, reason: 'BOOK_MISSING' })
      const chunks = await db.bookChunk.findMany({
        where: { programId, bookId: item.bookId, status: 'ANALYZED' },
        orderBy: { index: 'asc' }, take: 501,
        select: { id: true, index: true, pageStart: true, pageEnd: true, text: true },
      })
      const normalize = (text: string) => text.replace(/\s+/g, '').toLowerCase()
      const excerpt = normalize(String(item.excerpt || '').trim())
      const candidates = chunks.slice(0, 500).flatMap((chunk) => {
        if (excerpt.length < 60 || !chunk.text) return []
        const source = normalize(chunk.text)
        const full = source.includes(excerpt)
        if (!full && !source.includes(excerpt.slice(0, 60))) return []
        return [{
          chunkId: chunk.id, chunkIndex: chunk.index,
          pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
          matchLevel: full ? 'FULL_EXCERPT' : 'PREFIX_ONLY',
          sourceTextPreview: chunk.text.slice(0, 5000),
        }]
      }).sort((a, b) => (a.matchLevel === 'FULL_EXCERPT' ? 0 : 1) -
                         (b.matchLevel === 'FULL_EXCERPT' ? 0 : 1)).slice(0, 5)
      return NextResponse.json({
        itemId, bookTitle: book.title, candidates,
        examinedChunks: Math.min(500, chunks.length), truncated: chunks.length > 500,
        reason: candidates.length ? null : 'NO_TEXT_MATCH',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (req.nextUrl.searchParams.get('review') === '1') {
      // Cursor-based review over the actual table: the normal 140/2000-item
      // preview deliberately hides suspect content and cannot be used as a queue.
      let cursor = String(req.nextUrl.searchParams.get('cursor') || '').slice(0, 100)
      const collected: Awaited<ReturnType<typeof db.bookKnowledgeItem.findMany>> = []
      let hasMoreRows = false
      for (let scan = 0; scan < 4; scan++) {
        const rows = await db.bookKnowledgeItem.findMany({
          where: { programId, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 100,
        })
        if (!rows.length) { hasMoreRows = false; break }
        cursor = rows[rows.length - 1].id
        collected.push(...rows.filter((row) =>
          ['REVIEW', 'DELETE_EMPTY'].includes(planKnowledgeItemCleanup(row, looksLikeBrokenAcademicOutput).action) ||
          !row.bookId || !row.chunkId || row.pageStart == null || row.pageEnd == null
        ))
        hasMoreRows = rows.length === 100
        if (!hasMoreRows) break
      }
      // Paginate the collected review rows, not the scanned window: the old
      // code stopped after the first 20 matches and reported hasMore=false
      // whenever the table held fewer than 100 rows, silently dropping the rest.
      const rowsForReview = collected.slice(0, 20)
      const hasMore = collected.length > 20 || hasMoreRows
      const nextCursor = hasMore ? (collected.length > 20 ? rowsForReview[rowsForReview.length - 1].id : cursor) : null
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
      return NextResponse.json({ items, nextCursor, hasMore }, { headers: { 'Cache-Control': 'no-store' } })
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

// Admin-reviewed correction is intentionally separate from automatic cleanup.
// Preserve original item ID, book, chunk and page references on every edit.
export async function PATCH(req: NextRequest) {
  return withTimedResponse(async () => {
    try {
      const admin = await requireAdmin()
      const body = await req.json().catch(() => ({}))
      const programId = String(body.programId || '').trim()
      const id = String(body.id || '').trim()
      if (!programId || !id) return NextResponse.json({ error: 'البرنامج والعنصر مطلوبان' }, { status: 400 })

      if (body.action === 'restore-source') {
        // An explicit admin decision only. Restore the ORIGINAL item's source;
        // never create a replacement ID, borrow a different book, or infer a
        // precise PDF page from a multi-page source chunk.
        if (body.confirmSource !== true || typeof body.chunkId !== 'string') {
          return NextResponse.json({ error: 'تأكيد المصدر والمقطع الأصلي مطلوب' }, { status: 400 })
        }
        const item = await db.bookKnowledgeItem.findFirst({ where: { id, programId } })
        if (!item) return NextResponse.json({ error: 'عنصر المعرفة غير موجود في البرنامج' }, { status: 404 })
        if (!item.bookId) return NextResponse.json({ error: 'الكتاب الأصلي مفقود؛ لا يمكن إعادة الربط' }, { status: 422 })
        if (item.chunkId && item.pageStart != null && item.pageEnd != null) {
          return NextResponse.json({ error: 'العنصر مرتبط بالفعل بمصدر؛ لن نغيّره تلقائيًا' }, { status: 409 })
        }
        if (item.chunkId && item.chunkId !== body.chunkId) {
          return NextResponse.json({ error: 'مقطع العنصر الأصلي مختلف؛ يلزم تدقيق يدوي' }, { status: 409 })
        }
        const expectedAt = new Date(String(body.expectedUpdatedAt || ''))
        if (Number.isNaN(expectedAt.getTime()) || expectedAt.getTime() !== item.updatedAt.getTime()) {
          return NextResponse.json({ error: 'العنصر تغيّر؛ حدّث بياناته قبل اعتماد المصدر' }, { status: 409 })
        }
        const normalize = (value: string) => value.replace(/\s+/g, '').toLowerCase()
        const excerpt = normalize(String(item.excerpt || '').trim())
        if (excerpt.length < 60) {
          return NextResponse.json({ error: 'المقتطف أقصر من أن يثبت المصدر بصورة مستقلة' }, { status: 422 })
        }
        const [book, chunks] = await Promise.all([
          db.book.findFirst({ where: { id: item.bookId, programId }, select: { id: true } }),
          db.bookChunk.findMany({
            where: { programId, bookId: item.bookId, status: 'ANALYZED' },
            orderBy: { index: 'asc' }, take: 501,
            select: { id: true, index: true, pageStart: true, pageEnd: true, text: true },
          }),
        ])
        if (!book || chunks.length > 500) {
          return NextResponse.json({ error: 'تعذّر فحص الكتاب كاملًا؛ لم يتم تعديل المصدر' }, { status: 422 })
        }
        const fullMatches = chunks.filter((chunk) => chunk.text && normalize(chunk.text).includes(excerpt))
        if (fullMatches.length !== 1 || fullMatches[0].id !== body.chunkId) {
          return NextResponse.json({ error: 'المقتطف لا يطابق مقطعًا أصليًا وحيدًا بالكامل؛ لا يمكن اعتماد مصدر تخميني' }, { status: 422 })
        }
        const chunk = fullMatches[0]
        if (chunk.pageStart < 1 || chunk.pageEnd < chunk.pageStart) {
          return NextResponse.json({ error: 'نطاق صفحات المقطع غير صالح' }, { status: 422 })
        }
        const updated = await db.bookKnowledgeItem.updateMany({
          where: { id, programId, updatedAt: item.updatedAt },
          data: { chunkId: chunk.id, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd },
        })
        if (updated.count !== 1) {
          return NextResponse.json({ error: 'تغيّر العنصر بالتزامن؛ لم يتم ربطه' }, { status: 409 })
        }
        const refreshed = await db.bookKnowledgeItem.findFirst({
          where: { id, programId }, select: { id: true, updatedAt: true },
        })
        await audit(admin, 'RESTORE_KNOWLEDGE_ITEM_SOURCE', 'BookKnowledgeItem', id,
          `استعادة ربط المصدر الأصلي بعد مطابقة المقتطف كاملاً في مقطع محلّل وحيد: ${chunk.id}، صفحات ${chunk.pageStart}–${chunk.pageEnd}`)
          .catch((error) => console.error('Knowledge source restore audit failed after commit:', error))
        return NextResponse.json({
          ok: true, id, chunkId: chunk.id, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd,
          updatedAt: refreshed?.updatedAt || null,
        })
      }

      if (typeof body.title !== 'string' || typeof body.summary !== 'string' || typeof body.excerpt !== 'string') {
        return NextResponse.json({ error: 'اكتب عنوان العنصر وشرحه ومقتطف المصدر كاملاً قبل الاعتماد' }, { status: 422 })
      }
      const title = body.title.trim()
      const summary = body.summary.trim()
      const excerpt = body.excerpt.trim()
      if (title.length < 6 || title.length > 220 || summary.length < 20 || summary.length > 1800 || excerpt.length < 20 || excerpt.length > 1500) {
        return NextResponse.json({ error: 'عنوان أو شرح أو مقتطف المصدر غير مكتمل أو يتجاوز الحد المسموح' }, { status: 422 })
      }
      if (planKnowledgeItemCleanup({ title, summary, excerpt }, looksLikeBrokenAcademicOutput).action !== 'KEEP') {
        return NextResponse.json({ error: 'بقي تشوه أو جزء ناقص؛ راجع النصوص الثلاثة كاملة' }, { status: 422 })
      }
      const item = await db.bookKnowledgeItem.findFirst({ where: { id, programId } })
      if (!item) return NextResponse.json({ error: 'عنصر المعرفة غير موجود في هذا البرنامج' }, { status: 404 })
      if (!item.bookId || !item.chunkId || item.pageStart == null || item.pageEnd == null) {
        return NextResponse.json({ error: 'مصدر العنصر أو صفحات الكتاب مفقودة؛ يلزم استعادة المصدر قبل اعتماد التصحيح' }, { status: 422 })
      }
      const [book, chunk] = await Promise.all([
        db.book.findFirst({ where: { id: item.bookId, programId }, select: { id: true } }),
        db.bookChunk.findFirst({ where: { id: item.chunkId, programId, bookId: item.bookId }, select: { status: true, text: true, pageStart: true, pageEnd: true } }),
      ])
      if (!book || !chunk || chunk.status !== 'ANALYZED' ||
          item.pageStart < chunk.pageStart || item.pageEnd > chunk.pageEnd || item.pageStart > item.pageEnd) {
        return NextResponse.json({ error: 'الكتاب أو المقطع أو نطاق الصفحات غير قابل للتحقق؛ لم نغيّر العنصر' }, { status: 422 })
      }
      const compact = (text: string) => text.replace(/\s+/g, ' ').trim()
      if (!compact(chunk.text).includes(compact(excerpt))) {
        return NextResponse.json({ error: 'المقتطف المكتوب ليس جزءًا حرفيًا من مقطع الكتاب المرتبط؛ صححه من النص الأصلي' }, { status: 422 })
      }
      const expectedAt = new Date(String(body.expectedUpdatedAt || ''))
      if (Number.isNaN(expectedAt.getTime()) || expectedAt.getTime() !== item.updatedAt.getTime()) {
        return NextResponse.json({ error: 'العنصر تغيّر منذ فتحه؛ حدّث القائمة قبل حفظ مراجعتك' }, { status: 409 })
      }
      const updated = await db.bookKnowledgeItem.updateMany({
        where: { id, programId, updatedAt: item.updatedAt },
        data: { title, summary, excerpt },
      })
      if (updated.count !== 1) {
        return NextResponse.json({ error: 'العنصر تغيّر بالتزامن؛ لم يتم حفظ تعديل جزئي' }, { status: 409 })
      }
      await audit(admin, 'MANUAL_REVIEW_KNOWLEDGE_ITEM', 'BookKnowledgeItem', id,
        'تصحيح يدوي كامل ومعتمد من مصدر الكتاب، دون تغيير المعرّف أو المراجع')
      return NextResponse.json({ ok: true, id, title, summary, excerpt })
    } catch (e: any) {
      if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
      console.error('knowledge manual review error:', e)
      return NextResponse.json({ error: 'تعذر حفظ المراجعة اليدوية' }, { status: 500 })
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
        if (deleteIds.length) {
          // Empty rows can still be used by a saved guide, generated unit,
          // assignment or exam. Never orphan those source IDs while cleaning.
          const parseList = (value: unknown): any[] => {
            if (Array.isArray(value)) return value
            if (typeof value !== 'string') return []
            try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
          }
          const idsFrom = (value: unknown): string[] => parseList(value).filter((id): id is string => typeof id === 'string')
          const [guides, units, assignments, questions, bankQuestions, programQuestions] = await Promise.all([
            db.programStudyGuide.findMany({ where: { programId }, select: { sourceKnowledgeIds: true, sections: true } }),
            db.unit.findMany({ where: { programId }, select: { content: true } }),
            db.programAssignment.findMany({ where: { programId }, select: { sourceKnowledgeIds: true } }),
            db.question.findMany({ where: { knowledgeItemId: { in: deleteIds } }, select: { knowledgeItemId: true } }),
            db.questionBankItem.findMany({ where: { knowledgeItemId: { in: deleteIds } }, select: { knowledgeItemId: true } }),
            db.programQuestion.findMany({ where: { knowledgeItemId: { in: deleteIds } }, select: { knowledgeItemId: true } }),
          ])
          const linked = new Set<string>([
            ...guides.flatMap((guide) => [
              ...idsFrom(guide.sourceKnowledgeIds),
              ...parseList(guide.sections).flatMap((section) => idsFrom(section?.sourceKnowledgeIds)),
            ]),
            ...units.flatMap((unit) => parseList(unit.content).flatMap((section) => idsFrom(section?.sourceKnowledgeIds))),
            ...assignments.flatMap((assignment) => idsFrom(assignment.sourceKnowledgeIds)),
            ...questions.map((question) => question.knowledgeItemId).filter((id): id is string => !!id),
            ...bankQuestions.map((question) => question.knowledgeItemId).filter((id): id is string => !!id),
            ...programQuestions.map((question) => question.knowledgeItemId).filter((id): id is string => !!id),
          ])
          for (const row of rows.filter((item) => deleteIds.includes(item.id))) {
            if (linked.has(row.id)) { needsReview++; continue }
            // An item fixed concurrently must never be deleted from a stale
            // cleanup page: require its original optimistic timestamp.
            const result = await withTiming('db_knowledge_bank_sanitize_delete_empty', () =>
              db.bookKnowledgeItem.deleteMany({ where: { id: row.id, programId, updatedAt: row.updatedAt } }))
            if (result.count) deleted += result.count
            else needsReview++
          }
        }
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
