import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { outlineApprovalGuard, OUTLINE_SECTION_BLOCK_PAGES } from '@/lib/book-outline'

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
    const guard = outlineApprovalGuard(outline.sections)
    // A documented long-chapter override must NOT bypass missing pages.
    if (guard.report.gaps.length) {
      return NextResponse.json({
        code: 'OUTLINE_COVERAGE_GAPS',
        error: `لا يمكن اعتماد فهرس فيه فجوات صفحات داخلية: ${guard.report.gaps.map((gap) => `${gap.pageStart}–${gap.pageEnd}`).join('، ')}. أعد فحص حدود الأقسام قبل الاعتماد.`,
        gaps: guard.report.gaps,
      }, { status: 409 })
    }
    let warningsPrefix: string[] = []
    if (guard.decision === 'BLOCK') {
      const overrideReason = String(body?.overrideReason || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (body?.overrideOversized !== true || overrideReason.length < 3) {
        return NextResponse.json({
          error: `لا يمكن اعتماد الفهرس: توجد أقسام تتجاوز ${OUTLINE_SECTION_BLOCK_PAGES} صفحة (${guard.report.blocked.map((section) => `«${section.title}» ${section.pages} صفحة`).join('، ')}). قسّم النطاقات الكبيرة أو أعد بناء الفهرس، أو سجّل تجاوزاً موثّقاً بسبب واضح.`,
          code: 'OUTLINE_OVERSIZED_SECTIONS',
          blocked: guard.report.blocked,
        }, { status: 409 })
      }
      warningsPrefix = ['OUTLINE_OVERSIZED_OVERRIDE:' + JSON.stringify({ at: new Date().toISOString(), byAdminId: admin.id, reason: overrideReason, sections: guard.report.blocked.map((section) => ({ order: section.order, title: section.title, pages: section.pages })) })]
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
