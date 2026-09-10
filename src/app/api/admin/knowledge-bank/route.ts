import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getProgramKnowledgeItems, rebuildKnowledgeForBook, rebuildProgramKnowledge } from '@/lib/knowledge-bank'

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

    const items = await getProgramKnowledgeItems(programId, semester, 140)
    const booksCount = await db.book.count({ where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) } })
    const contextPreview = items.length ? await buildKnowledgeContextForExam(programId, semester, 16) : ''
    return NextResponse.json({
      program,
      booksCount,
      count: items.length,
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

    if (action === 'rebuild-book') {
      if (!bookId) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })
      const result = await rebuildKnowledgeForBook(bookId)
      await audit(admin, 'REBUILD_BOOK_KNOWLEDGE', 'Book', bookId, `بناء ${result.inserted} عنصر معرفة من كتاب واحد`)
      const items = await getProgramKnowledgeItems(result.programId, semester, 140)
      return NextResponse.json({ ok: true, result, count: items.length, stats: categoryStats(items), items })
    }

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const result = await rebuildProgramKnowledge(programId, semester)
    await audit(admin, 'REBUILD_PROGRAM_KNOWLEDGE', 'Program', programId, `بناء ${result.totalInserted} عنصر معرفة من كتب البرنامج`)
    const items = await getProgramKnowledgeItems(programId, semester, 140)
    return NextResponse.json({ ok: true, result, count: items.length, stats: categoryStats(items), items })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('knowledge-bank POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر بناء بنك المعرفة' }, { status: 500 })
  }
}
