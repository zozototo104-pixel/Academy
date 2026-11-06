import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { auditOutlineCoverage, buildBookOutline, verifyBlankPdfGapPages, missingBookSourcePageRanges, subtractVerifiedBlankPages } from '@/lib/book-outline'
import { parseBookPageReadIssues } from '@/lib/book-read-job-control'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

async function programDraft(programId: string) {
  const books = await db.book.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true } })
  const outlines = await db.bookOutline.findMany({ where: { bookId: { in: books.map((book) => book.id) } }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
  const latest = new Map<string, typeof outlines[number]>()
  for (const outline of outlines) if (!latest.has(outline.bookId)) latest.set(outline.bookId, outline)
  return books.flatMap((book) => (latest.get(book.id)?.sections || []).map((section) => ({ ...section, bookId: book.id, bookTitle: book.title, semester: section.semester ?? book.semester, semesterNeedsReview: section.semester == null })))
    .sort((a, b) => (a.semester ?? 999) - (b.semester ?? 999) || books.findIndex((book) => book.id === a.bookId) - books.findIndex((book) => book.id === b.bookId) || a.order - b.order)
}

export async function GET(_req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = await db.bookOutline.findFirst({ where: { bookId: id }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
    // Historical warnings were recorded at BUILD time, before a supervisor
    // could remove/merge sections. Never show those frozen warnings as the
    // current audit; recompute against the original stored book extent.
    let currentOutline = outline
    if (outline) {
      const sourceChunks = await db.bookChunk.findMany({
        where: { bookId: id }, select: { pageStart: true, pageEnd: true },
      })
      const readJob = await db.bookReadJob.findFirst({
        where: { bookId: id, totalPages: { gt: 0 } }, orderBy: { createdAt: 'desc' },
        select: { totalPages: true, lastError: true },
      })
      const range = sourceChunks.length ? {
        pageStart: 1,
        pageEnd: Math.max(readJob?.totalPages || 0, ...sourceChunks.map((chunk) => chunk.pageEnd)),
      } : undefined
      const unchecked = auditOutlineCoverage(outline.sections, range)
      const rawSourceGaps = range ? missingBookSourcePageRanges(sourceChunks, range) : []
      const possibleGaps = [...unchecked.gaps, ...rawSourceGaps]
      const verifiedBlankPages = possibleGaps.length
        ? await verifyBlankPdfGapPages(id, possibleGaps) : []
      const coverage = auditOutlineCoverage(outline.sections, range, verifiedBlankPages)
      const unresolvedSource = subtractVerifiedBlankPages(rawSourceGaps, verifiedBlankPages)
      const readIssues = parseBookPageReadIssues(readJob?.lastError)
        .filter((issue) => !verifiedBlankPages.includes(issue.page))
      const warnings = (() => { try { const x = JSON.parse(outline.warnings || '[]'); return Array.isArray(x) ? x.map(String) : [] } catch { return [] as string[] } })()
        .filter((warning) => !warning.startsWith('تنبيه تغطية:') && !warning.startsWith('OUTLINE_COVERAGE:'))
      for (const section of coverage.review) {
        if (section.pages === null) warnings.push(`تنبيه تغطية: حدود صفحات القسم «${section.title}» غير مكتملة؛ لا يمكن اعتماده حتى تصحيحها.`)
        else if (section.band === 'REVIEW') warnings.push(`تنبيه تغطية: القسم «${section.title}» يمتد ${section.pages} صفحة ويحتاج مراجعة.`)
      }
      if (verifiedBlankPages.length) warnings.push(
        'صفحات بيضاء تم التحقق منها بصريًا في PDF الأصلي، ولا تُعد فجوات معرفية: ' + verifiedBlankPages.join('، ') + '.')
      for (const gap of coverage.gaps) warnings.push(`تنبيه تغطية: صفحات ${gap.pageStart}–${gap.pageEnd} غير ممثلة في الفهرس؛ ستظهر في تقرير اعتماد مع الإقرار.`)
      for (const gap of unresolvedSource) warnings.push(
        `تنبيه تغطية: صفحات المصدر ${gap.pageStart}–${gap.pageEnd} غير مقروءة أو غير ممثلة بمقاطع النص؛ دمج الفصول لا يُخفي هذه الفجوة.`)
      for (const issue of readIssues) warnings.push(
        `تنبيه قراءة: صفحة ${issue.page} — ${issue.kind === 'PARTIAL' ? 'قراءة جزئية' : 'لم تُقرأ'}؛ ${issue.reason}.`)
      for (const section of coverage.blocked) warnings.push(`تنبيه تغطية: القسم «${section.title}» يتجاوز 80 صفحة؛ يحتاج تقسيمًا موثقًا.`)
      currentOutline = { ...outline, warnings: JSON.stringify(warnings) }
    }
    return NextResponse.json({ outline: currentOutline, programDraft: await programDraft(book.programId) })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}

export async function POST(_req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    let outline
    try {
      outline = await buildBookOutline(id)
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.startsWith('BOOK_OUTLINE_OCR_TOO_MANY_PAGES')) throw error
      // The resumable reader has already completed OCR for this book. Use its
      // persisted evidence instead of paying for or truncating OCR a second time.
      const completeRead = await db.bookReadJob.findFirst({
        where: { bookId: id, status: 'COMPLETED', phase: 'DONE', totalChunks: { gt: 0 } },
        orderBy: { createdAt: 'desc' }, select: { id: true },
      })
      if (!completeRead) throw error
      // Reuse completed OCR evidence, but retain the legacy evidence-grounded AI
      // segmentation when no trustworthy chapter/article headings are present.
      outline = await buildBookOutline(id, { reuseReadChunks: true })
    }
    return NextResponse.json({ ok: true, outline, programDraft: await programDraft(book.programId) })
  } catch (error: any) {
    if (error?.message === 'BOOK_OUTLINE_VERSION_CONFLICT') {
      return NextResponse.json({ code: 'BOOK_OUTLINE_VERSION_CONFLICT', error: 'يُبنى فهرس آخر لهذا الكتاب في هذه اللحظة — أعد المحاولة بعد لحظات' }, { status: 409 })
    }
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
