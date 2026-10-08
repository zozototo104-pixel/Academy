import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getProgramKnowledgeItems, rebuildKnowledgeForBook, rebuildProgramKnowledge, cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput, KNOWLEDGE_BANK_LIMITS } from '@/lib/knowledge-bank'
import { scheduleProgramKnowledgeV2 } from '@/lib/book-knowledge-v2-scheduler'

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
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId') || ''
    const semRaw = req.nextUrl.searchParams.get('semester')
    const semester = semRaw ? Number(semRaw) || null : null
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const allItems = await getProgramKnowledgeItems(programId, semester, 140)
    const items = req.nextUrl.searchParams.get('all') === '1' ? allItems : allItems.slice(0, 140)
    const booksCount = await db.book.count({ where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) } })
    const v2BookCounts = await db.bookKnowledgeItem.groupBy({
      by: ['bookId'],
      where: { programId, kbVersion: 2, bookId: { not: null }, category: { notIn: ['LEGACY', 'QUESTION_SEED'] } },
      _count: { _all: true },
    })
    const v2CountsByBook = Object.fromEntries(v2BookCounts.filter((row) => row.bookId).map((row) => [row.bookId!, row._count._all]))
    const contextPreview = items.length
      ? items.slice(0, 16).map((item, i) => `${i + 1}. [${item.category}] ${item.title}: ${item.summary.slice(0, 320)}${item.bookTitle ? ` — المصدر: ${item.bookTitle}` : ''}`).join('\n')
      : ''
    return NextResponse.json({
      program,
      booksCount,
      v2CountsByBook,
      count: allItems.length,
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
}

// POST /api/admin/knowledge-bank — action: rebuild | rebuild-book
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || 'rebuild').trim()
    const programId = String(body.programId || '').trim()
    const bookId = String(body.bookId || '').trim()
    const semRaw = body.semester
    const semester = semRaw ? Number(semRaw) || null : null

    if (action === 'sanitize' || action === 'clean') {
      if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
      const rows = await db.bookKnowledgeItem.findMany({ where: { programId }, take: 1200 })
      const deleteIds: string[] = []
      const updates: Promise<any>[] = []
      for (const row of rows) {
        const title = cleanAcademicGeneratedText(row.title, 220)
        const summary = cleanAcademicGeneratedText(row.summary, 1600)
        const excerpt = row.excerpt ? cleanAcademicGeneratedText(row.excerpt, 1800) : null
        if (!title || !summary || looksLikeBrokenAcademicOutput(`${title}. ${summary}`) || (excerpt && looksLikeBrokenAcademicOutput(excerpt))) {
          deleteIds.push(row.id)
          continue
        }
        if (title !== row.title || summary !== row.summary || excerpt !== row.excerpt) {
          updates.push(db.bookKnowledgeItem.update({ where: { id: row.id }, data: { title, summary, excerpt } }))
        }
      }
      if (deleteIds.length) await db.bookKnowledgeItem.deleteMany({ where: { id: { in: deleteIds } } })
      if (updates.length) await Promise.all(updates)
      await audit(admin, 'SANITIZE_KNOWLEDGE_BANK', 'Program', programId, `تنظيف بنك المعرفة: حذف ${deleteIds.length} عنصر مشوه وتحديث ${updates.length} عنصر`)
      const items = await getProgramKnowledgeItems(programId, semester, 140)
      const message = items.length < KNOWLEDGE_BANK_LIMITS.minContextItems ? 'شغّل القراءة الكاملة أو استخراج المزيد' : null
      return NextResponse.json({ ok: true, deleted: deleteIds.length, updated: updates.length, rebuilt: null, message, count: items.length, stats: categoryStats(items), items })
    }

    if (action === 'rebuild-book' || action === 'read-book-full') {
      if (!bookId) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })
      const strictFullRead = action === 'read-book-full' || body.strictFullRead === true
      let result
      try {
        result = await rebuildKnowledgeForBook(bookId, { strictFullRead })
      } catch (e: any) {
        if (e?.code !== 'AI_ACADEMIC_PROVIDER_UNAVAILABLE') throw e
        const paused = { code: e.code, reason: String(e?.message || e).slice(0, 500), retryAt: e?.retryAt || null, pausedAt: new Date().toISOString() }
        await db.setting.upsert({
          where: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}` },
          create: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}`, value: JSON.stringify(paused) },
          update: { value: JSON.stringify(paused) },
        }).catch(() => {})
        return NextResponse.json({ error: 'توقف تحليل الكتاب مؤقتاً لأن المزود الأكاديمي غير متاح. يمكن استئنافه لاحقاً من نفس زر القراءة الكاملة.', status: 'PAUSED', ...paused }, { status: 503 })
      }
      await db.setting.delete({ where: { key: `AI_TASK_PAUSE:KNOWLEDGE:${bookId}` } }).catch(() => {})
      await audit(admin, strictFullRead ? 'READ_FULL_BOOK_KNOWLEDGE' : 'REBUILD_BOOK_KNOWLEDGE', 'Book', bookId, `${strictFullRead ? 'قراءة وتحليل كامل للكتاب' : 'بناء'} ${result.inserted} عنصر معرفة من كتاب واحد`)
      const items = await getProgramKnowledgeItems(result.programId, semester, 140)
      return NextResponse.json({ ok: true, strictFullRead, result, count: items.length, stats: categoryStats(items), items })
    }

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    // The program-wide rebuild button schedules v2 jobs; the legacy v1 builder stays available for other paths.
    const result = await scheduleProgramKnowledgeV2(programId, semester)
    await audit(admin, 'SCHEDULE_PROGRAM_KNOWLEDGE_V2', 'Program', programId, `جدولة/استكمال ${result.results.length} كتاب عبر v2`)
    const items = await getProgramKnowledgeItems(programId, semester, 140)
    return NextResponse.json({ ok: true, result, count: items.length, stats: categoryStats(items), items })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('knowledge-bank POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر بناء بنك المعرفة' }, { status: 500 })
  }
}
