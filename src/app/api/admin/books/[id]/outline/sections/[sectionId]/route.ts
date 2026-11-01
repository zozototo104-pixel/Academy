import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { remapOutlineReviewWarnings } from '@/lib/book-outline'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string; sectionId: string }> }

export async function DELETE(request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id, sectionId } = await context.params
    const mergeInto = request.nextUrl.searchParams.get('mergeInto')
    if (mergeInto !== 'previous' && mergeInto !== 'next') {
      return NextResponse.json({ code: 'OUTLINE_MERGE_TARGET_REQUIRED', error: 'تجاهل العنوان وحده يفقد صفحات الكتاب. اختر ضم محتواه للقسم السابق أو التالي، أو اتركه للمراجعة.' }, { status: 400 })
    }
    const section = await db.bookOutlineSection.findFirst({
      where: { id: sectionId, outline: { bookId: id, status: 'DRAFT' } },
      select: { id: true, outlineId: true },
    })
    if (!section) return NextResponse.json({ error: 'القسم غير موجود أو الفهرس معتمد' }, { status: 404 })
    const outline = await db.bookOutline.findUnique({
      where: { id: section.outlineId }, select: { warnings: true },
    })
    const sections = await db.bookOutlineSection.findMany({
      where: { outlineId: section.outlineId }, orderBy: [{ order: 'asc' }, { id: 'asc' }],
    })
    const index = sections.findIndex((entry) => entry.id === sectionId)
    const target = sections[index + (mergeInto === 'previous' ? -1 : 1)]
    const removed = sections[index]
    if (!target || !removed) return NextResponse.json({ code: 'OUTLINE_ADJACENT_SECTION_REQUIRED', error: 'لا يوجد قسم مجاور في الاتجاه المختار' }, { status: 409 })
    if (removed.semester !== target.semester ||
      removed.pageStart == null || removed.pageEnd == null ||
      target.pageStart == null || target.pageEnd == null ||
      removed.pageEnd < removed.pageStart || target.pageEnd < target.pageStart) {
      return NextResponse.json({ code: 'OUTLINE_MERGE_UNVERIFIED_PAGES', error: 'حدود صفحات القسم غير مكتملة؛ أعد بناء الفهرس من المصدر قبل دمجه.' }, { status: 409 })
    }
    const left = mergeInto === 'previous' ? target : removed
    const right = mergeInto === 'previous' ? removed : target
    if (right.pageStart == null || left.pageEnd == null ||
      right.pageStart > left.pageEnd + 1 ||
      right.chunkStartIndex > left.chunkEndIndex + 1 ||
      right.chunkEndIndex < left.chunkStartIndex) {
      return NextResponse.json({ code: 'OUTLINE_MERGE_GAP', error: 'لا يمكن ضم قسمين بينهما صفحات أو مقاطع غير موثقة؛ أعد بناء الفهرس.' }, { status: 409 })
    }
    const linkedUnits = await db.unit.count({ where: { outlineSectionId: { in: [sectionId, target.id] } } })
    if (linkedUnits) return NextResponse.json({ error: 'لا يمكن ضم أقسام مرتبطة بوحدات قائمة' }, { status: 409 })

    const merged = {
      chunkStartIndex: Math.min(removed.chunkStartIndex, target.chunkStartIndex),
      chunkEndIndex: Math.max(removed.chunkEndIndex, target.chunkEndIndex),
      pageStart: Math.min(removed.pageStart, target.pageStart),
      pageEnd: Math.max(removed.pageEnd, target.pageEnd),
      // If the target is the following article, its source evidence now
      // begins at the removed article's offset, not at its old title.
      startCharOffset: mergeInto === 'next' ? removed.startCharOffset : target.startCharOffset,
    }
    const chunks = await db.bookChunk.findMany({
      where: { bookId: id, index: { gte: merged.chunkStartIndex, lte: merged.chunkEndIndex } },
      select: { id: true },
    })
    if (!chunks.length) return NextResponse.json({ code: 'OUTLINE_SOURCE_MISSING', error: 'مقاطع المصدر المطلوبة للضم غير متاحة' }, { status: 409 })
    const itemsCount = await db.bookKnowledgeItem.count({
      where: { bookId: id, kbVersion: 2, chunkId: { in: chunks.map((chunk) => chunk.id) } },
    })
    const survivors = sections.filter((entry) => entry.id !== sectionId)
    const orderByOld = new Map(survivors.map((entry, position) => [entry.order, position + 1]))
    const oldTargetOrder = target.order
    const oldRemovedOrder = removed.order
    const oldWarnings = (() => { try { const x = JSON.parse(outline?.warnings || '[]'); return Array.isArray(x) ? x.map(String) : [] } catch { return [] as string[] } })()
    const warnings = remapOutlineReviewWarnings(oldWarnings, orderByOld, oldRemovedOrder, oldTargetOrder)
    warnings.push('OUTLINE_MERGED_TITLE:' + JSON.stringify({
      sectionOrder: orderByOld.get(oldTargetOrder), title: removed.title,
      pageStart: removed.pageStart, pageEnd: removed.pageEnd,
    }))
    warnings.push(`تم ضم العنوان «${removed.title}» (صفحات ${removed.pageStart}–${removed.pageEnd}) إلى «${target.title}» مع حفظ الصفحات والمقاطع المرجعية.`)
    // Do not let a failed reorder or merge lose the original pages.
    await db.$transaction(async (tx) => {
      await tx.bookOutlineSection.delete({ where: { id: sectionId } })
      await tx.bookOutlineSection.update({
        where: { id: target.id }, data: { ...merged, itemsCount },
      })
      for (let position = 0; position < survivors.length; position++) {
        await tx.bookOutlineSection.update({
          where: { id: survivors[position].id }, data: { order: -1000000 - position },
        })
      }
      for (let position = 0; position < survivors.length; position++) {
        await tx.bookOutlineSection.update({
          where: { id: survivors[position].id }, data: { order: position + 1 },
        })
      }
      await tx.bookOutline.update({
        where: { id: section.outlineId }, data: { warnings: JSON.stringify(warnings) },
      })
    })
    return NextResponse.json({ ok: true, mergedInto: target.id, itemsCount })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id, sectionId } = await context.params
    const body = await request.json()
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 180 || Object.keys(body).some((key) => key !== 'title')) {
      return NextResponse.json({ error: 'عنوان القسم مطلوب (180 حرفاً كحد أقصى)' }, { status: 400 })
    }
    const section = await db.bookOutlineSection.findFirst({ where: { id: sectionId, outline: { bookId: id, status: 'DRAFT' } }, select: { id: true } })
    if (!section) return NextResponse.json({ error: 'القسم غير موجود أو الفهرس معتمد' }, { status: 404 })
    const updated = await db.bookOutlineSection.update({ where: { id: section.id }, data: { title: body.title.trim() } })
    return NextResponse.json({ ok: true, section: updated })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
