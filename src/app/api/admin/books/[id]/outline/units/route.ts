import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { planOutlineUnitsFromSections } from '@/lib/outline-units'

export const runtime = 'nodejs'
export const maxDuration = 120
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

function clean(value: unknown, max = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function latestOutline(bookId: string, outlineId?: string) {
  if (outlineId) {
    return db.bookOutline.findFirst({
      where: { id: outlineId, bookId },
      include: { sections: { orderBy: { order: 'asc' } } },
    })
  }
  return db.bookOutline.findFirst({
    where: { bookId },
    orderBy: { version: 'desc' },
    include: { sections: { orderBy: { order: 'asc' } } },
  })
}

export async function POST(req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const body = await req.json().catch(() => ({}))
    const regenerateDrafts = Boolean(body?.regenerateDrafts || body?.regenerate)
    const outlineId = clean(body?.outlineId, 100)
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true, title: true, semester: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = await latestOutline(id, outlineId || undefined)
    if (!outline) return NextResponse.json({ error: 'BOOK_OUTLINE_NOT_FOUND' }, { status: 404 })
    if (!['APPROVED', 'DRAFT'].includes(String(outline.status || '').toUpperCase())) {
      return NextResponse.json({ error: 'لا يمكن إنشاء وحدات إلا من فهرس DRAFT أو APPROVED' }, { status: 400 })
    }
    const sections = outline.sections.map((section) => ({
      id: section.id,
      title: section.title,
      level: section.level,
      semester: section.semester,
      chunkStartIndex: section.chunkStartIndex,
      chunkEndIndex: section.chunkEndIndex,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
    }))
    const sectionIds = sections.map((section) => section.id)
    const [existingUnits, allUnits] = await Promise.all([
      db.unit.findMany({
        where: { programId: book.programId, outlineSectionId: { in: sectionIds } },
        select: { id: true, outlineSectionId: true, status: true, order: true, semester: true, generationVersion: true },
      }),
      db.unit.findMany({ where: { programId: book.programId }, select: { semester: true, order: true } }),
    ])
    const currentMaxOrderBySemester = allUnits.reduce<Record<number, number>>((acc, unit) => {
      const semester = Number(unit.semester || 1)
      acc[semester] = Math.max(acc[semester] || 0, Number(unit.order || 0))
      return acc
    }, {})
    const actions = planOutlineUnitsFromSections({ sections, existingUnits, currentMaxOrderBySemester, bookSemester: book.semester, regenerateDrafts })
    const changedIds: string[] = []
    for (const action of actions) {
      if (action.action === 'create') {
        const created = await db.unit.create({
          data: {
            programId: book.programId,
            order: action.order,
            semester: action.semester,
            status: 'DRAFT',
            title: clean(action.section.title, 220) || 'وحدة من فهرس الكتاب',
            summary: `مسودة وحدة مولدة من فهرس كتاب «${book.title}» في نطاق الصفحات ${action.section.pageStart ?? '؟'}–${action.section.pageEnd ?? '؟'}.`,
            objectives: JSON.stringify([]),
            content: JSON.stringify([]),
            sourceBookId: book.id,
            outlineSectionId: action.section.id,
            chunkStartIndex: action.section.chunkStartIndex,
            chunkEndIndex: action.section.chunkEndIndex,
            generationVersion: 1,
          },
          select: { id: true },
        })
        changedIds.push(created.id)
      } else if (action.action === 'update-draft') {
        await db.unit.updateMany({
          where: { id: action.unitId, programId: book.programId, status: { not: 'APPROVED' } },
          data: {
            title: clean(action.section.title, 220) || 'وحدة من فهرس الكتاب',
            summary: `مسودة وحدة معاد ربطها بفهرس كتاب «${book.title}» في نطاق الصفحات ${action.section.pageStart ?? '؟'}–${action.section.pageEnd ?? '؟'}.`,
            semester: action.semester,
            sourceBookId: book.id,
            outlineSectionId: action.section.id,
            chunkStartIndex: action.section.chunkStartIndex,
            chunkEndIndex: action.section.chunkEndIndex,
            generationVersion: action.generationVersion,
          },
        })
        changedIds.push(action.unitId)
      }
    }
    if (changedIds.length) {
      await db.program.update({ where: { id: book.programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    }
    const units = await db.unit.findMany({
      where: { programId: book.programId },
      orderBy: [{ semester: 'asc' }, { order: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, status: true, order: true, semester: true, sourceBookId: true, outlineSectionId: true, chunkStartIndex: true, chunkEndIndex: true, generationVersion: true },
    })
    return NextResponse.json({
      ok: true,
      outline: { id: outline.id, status: outline.status, version: outline.version },
      summary: {
        created: actions.filter((a) => a.action === 'create').length,
        updatedDrafts: actions.filter((a) => a.action === 'update-draft').length,
        skippedApproved: actions.filter((a) => a.action === 'skip-approved').length,
        skippedDrafts: actions.filter((a) => a.action === 'skip-draft').length,
        skippedIntro: actions.filter((a) => a.action === 'skip-intro').length,
      },
      actions,
      units,
    })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
