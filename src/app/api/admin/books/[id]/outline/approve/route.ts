import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { createHash } from 'node:crypto'
import { outlineApprovalGuard, verifyBlankPdfGapPages, missingBookSourcePageRanges, subtractVerifiedBlankPages, OUTLINE_SECTION_BLOCK_PAGES } from '@/lib/book-outline'
import { parseBookPageReadIssues } from '@/lib/book-read-job-control'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, context: Context) {
  try {
    const admin = await requireAdmin()
    const { id } = await context.params
    const body = await req.json().catch(() => ({}))
    const outlineId = String(body?.outlineId || '').trim()
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = outlineId
      ? await db.bookOutline.findFirst({ where: { id: outlineId, bookId: id }, include: { sections: { orderBy: { order: 'asc' } } } })
      : await db.bookOutline.findFirst({ where: { bookId: id }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
    if (!outline) return NextResponse.json({ error: 'BOOK_OUTLINE_NOT_FOUND' }, { status: 404 })
    // Coverage guard: a section above the block band means its range never
    // yielded grounded sub-boundaries. Approving it would mint a unit that
    // swallows that whole range, so approval is refused unless a supervisor
    // records an explicit override (a genuine long chapter passes by a
    // documented decision, never silently).
    const sourceChunks = await db.bookChunk.findMany({
      where: { bookId: id }, select: { pageStart: true, pageEnd: true },
    })
    if (!sourceChunks.length) return NextResponse.json({ code: 'OUTLINE_SOURCE_MISSING', error: 'مقاطع الكتاب الأصلية غير متاحة للتحقق من التغطية' }, { status: 409 })
    const latestRead = await db.bookReadJob.findFirst({
      where: { bookId: id, totalPages: { gt: 0 } }, orderBy: { createdAt: 'desc' },
      select: { totalPages: true, lastError: true },
    })
    const sourceRange = {
      pageStart: 1,
      pageEnd: Math.max(latestRead?.totalPages || 0, ...sourceChunks.map((chunk) => chunk.pageEnd)),
    }
    const rawCoverage = outlineApprovalGuard(outline.sections, sourceRange)
    // These gaps are computed from the actual stored source chunks, not only
    // outline section spans. A successful section MERGE cannot hide a page
    // that was never read or misrepresent it as academic evidence.
    const missingSource = missingBookSourcePageRanges(sourceChunks, sourceRange)
    const possibleGaps = [...rawCoverage.report.gaps, ...missingSource]
    const verifiedBlankPages = possibleGaps.length
      ? await verifyBlankPdfGapPages(id, possibleGaps) : []
    const guard = outlineApprovalGuard(outline.sections, sourceRange, verifiedBlankPages)
    const unreadSource = subtractVerifiedBlankPages(missingSource, verifiedBlankPages)
    const readIssues = parseBookPageReadIssues(latestRead?.lastError)
      .filter((issue) => !verifiedBlankPages.includes(issue.page))
    const pdfReadIssues = (() => {
      try {
        const warnings = JSON.parse(outline.warnings || '[]')
        if (!Array.isArray(warnings)) return [] as { page: number; kind: string; reason: string }[]
        return warnings.filter((warning): warning is string => typeof warning === 'string' && warning.startsWith('OUTLINE_PDF_READ_ISSUES:'))
          .flatMap((warning) => {
            try {
              const items = JSON.parse(warning.slice('OUTLINE_PDF_READ_ISSUES:'.length))
              return Array.isArray(items) ? items.filter((item) => Number.isSafeInteger(item?.page) && item.page > 0 && typeof item.reason === 'string') : []
            } catch { return [] }
          })
          .filter((issue) => !verifiedBlankPages.includes(issue.page))
      } catch { return [] }
    })()
    const rawGaps = [...guard.report.gaps, ...unreadSource].sort((a, b) => a.pageStart - b.pageStart)
    const unresolvedGaps: typeof rawGaps = []
    for (const gap of rawGaps) {
      const previous = unresolvedGaps[unresolvedGaps.length - 1]
      if (previous && gap.pageStart <= previous.pageEnd + 1) previous.pageEnd = Math.max(previous.pageEnd, gap.pageEnd)
      else unresolvedGaps.push({ ...gap })
    }
    // Unknown page ends must never be bypassed by the documented long-section override.
    const incomplete = guard.report.sections.filter((section) => section.pages === null)
    if (!outline.sections.length || incomplete.length) {
      return NextResponse.json({
        code: 'OUTLINE_INCOMPLETE_PAGE_RANGES',
        error: `لا يمكن اعتماد الفهرس: توجد حدود صفحات غير محسومة (${incomplete.map((section) => section.title).join('، ') || 'لا توجد أقسام'}). أعد بناء الفهرس ثم راجع الأقسام.`,
        incomplete,
      }, { status: 409 })
    }
    const reviewMessages = [
      ...verifiedBlankPages.map((page) => `صفحة ${page}: بيضاء حسب فحص الصورة الأصلية (لا تحتوي معرفة مستخرجة).`),
      ...unresolvedGaps.map((gap) => `صفحات ${gap.pageStart}–${gap.pageEnd}: غير ممثلة في نص المصدر المحفوظ؛ لا تعتبر مقروءة حتى لو تم دمج الفصلين المحيطين.`),
      ...readIssues.map((issue) => `صفحة ${issue.page}: ${issue.kind === 'PARTIAL' ? 'قراءة جزئية' : 'تعذرت قراءتها'} — ${issue.reason}.`),
    ]
    const acknowledgmentKey = createHash('sha256').update(JSON.stringify({
      outlineId: outline.id,
      sections: outline.sections.map((section) => ({
        id: section.id, pageStart: section.pageStart, pageEnd: section.pageEnd,
        chunkStartIndex: section.chunkStartIndex, chunkEndIndex: section.chunkEndIndex,
      })),
      gaps: unresolvedGaps, readIssues, verifiedBlankPages,
    })).digest('hex')
    if (reviewMessages.length && (body?.acknowledgeCoverage !== true || body?.acknowledgmentKey !== acknowledgmentKey)) {
      return NextResponse.json({
        code: 'OUTLINE_REVIEW_REQUIRED',
        error: 'يوجد تقرير صفحات ناقصة أو غير مقروءة. راجع كل بند، ثم اعتمد صراحة مع الإقرار أو ارفض الاعتماد.',
        issues: reviewMessages,
        gaps: unresolvedGaps, readIssues, verifiedBlankPages, acknowledgmentKey,
      }, { status: 409 })
    }
    let warningsPrefix: string[] = reviewMessages.length ? [
      'OUTLINE_REVIEW_ACK:' + JSON.stringify({
        at: new Date().toISOString(), byAdminId: admin.id,
        gaps: unresolvedGaps, readIssues, verifiedBlankPages, acknowledgmentKey,
      }),
    ] : []
    // Acknowledging lost pages NEVER bypasses unknown section bounds or a
    // genuinely oversized section; the latter keeps its documented gate.
    if (guard.report.blocked.length) {
      const overrideReason = String(body?.overrideReason || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (body?.overrideOversized !== true || overrideReason.length < 3) {
        return NextResponse.json({
          error: `لا يمكن اعتماد الفهرس: توجد أقسام تتجاوز ${OUTLINE_SECTION_BLOCK_PAGES} صفحة (${guard.report.blocked.map((section) => `«${section.title}» ${section.pages} صفحة`).join('، ')}). قسّم النطاقات الكبيرة أو أعد بناء الفهرس، أو سجّل تجاوزاً موثّقاً بسبب واضح.`,
          code: 'OUTLINE_OVERSIZED_SECTIONS',
          blocked: guard.report.blocked,
        }, { status: 409 })
      }
      warningsPrefix.push('OUTLINE_OVERSIZED_OVERRIDE:' + JSON.stringify({ at: new Date().toISOString(), byAdminId: admin.id, reason: overrideReason, sections: guard.report.blocked.map((section) => ({ order: section.order, title: section.title, pages: section.pages })) }))
    }
    const existingWarnings = (() => { try { const parsed = JSON.parse(outline.warnings || '[]'); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })()
    const updated = await db.bookOutline.update({
      where: { id: outline.id },
      data: { status: 'APPROVED', ...(warningsPrefix.length ? { warnings: JSON.stringify([...warningsPrefix, ...existingWarnings]) } : {}) },
      include: { sections: { orderBy: { order: 'asc' } } },
    })
    return NextResponse.json({ ok: true, outline: updated, guard: { decision: guard.decision, maxSectionPages: guard.report.maxSectionPages, review: guard.report.review.map((section) => section.order), blocked: guard.report.blocked.map((section) => section.order) } })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
