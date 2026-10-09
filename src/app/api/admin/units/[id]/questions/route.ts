import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { selectUnitExamQuestionsApprovedFirst, unitExamRequiredQuestions } from '@/lib/unit-exam-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function groupByStatus<T extends { status: string }>(items: T[]) {
  return {
    APPROVED: items.filter((item) => item.status === 'APPROVED'),
    PENDING_REVIEW: items.filter((item) => item.status === 'PENDING_REVIEW'),
    REJECTED: items.filter((item) => item.status === 'REJECTED'),
  }
}

function reviewNotes(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function nestedString(record: Record<string, unknown>, key: string, nestedKey: string) {
  const nested = record[key]
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return null
  const value = (nested as Record<string, unknown>)[nestedKey]
  return typeof value === 'string' && value.trim() ? value : null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const unitId = clean(id, 100)
    if (!unitId) return NextResponse.json({ error: 'معرف الوحدة مطلوب' }, { status: 400 })
    const unit = await db.unit.findUnique({
      where: { id: unitId },
      select: { id: true, title: true, programId: true, exam: { select: { id: true, title: true, status: true, _count: { select: { questions: true } } } } },
    })
    if (!unit) return NextResponse.json({ error: 'الوحدة غير موجودة' }, { status: 404 })
    const [items, job] = await Promise.all([
      db.questionBankItem.findMany({
        where: { unitId: unit.id },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          knowledgeItemId: true,
          text: true,
          type: true,
          options: true,
          correctAnswer: true,
          modelAnswer: true,
          sourceEvidence: true,
          sourceLocator: true,
          cognitiveSkill: true,
          difficulty: true,
          reviewNotes: true,
          status: true,
          qualityFlags: true,
          rejectedReason: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      db.questionBankGenerationJob.findFirst({ where: { unitId: unit.id }, orderBy: { createdAt: 'desc' } }),
    ])
    const knowledgeIds = [...new Set(items.map((item) => item.knowledgeItemId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
    const knowledgeItems = knowledgeIds.length
      ? await db.bookKnowledgeItem.findMany({ where: { id: { in: knowledgeIds } }, select: { id: true, pageStart: true, pageEnd: true, title: true } })
      : []
    const knowledgeById = new Map(knowledgeItems.map((item) => [item.id, item] as const))
    const requiredQuestions = unitExamRequiredQuestions(job?.requested)
    const questions = items.map((item) => {
      const notes = reviewNotes(item.reviewNotes)
      const knowledge = item.knowledgeItemId ? knowledgeById.get(item.knowledgeItemId) : null
      return {
        ...item,
        pageStart: knowledge?.pageStart ?? null,
        pageEnd: knowledge?.pageEnd ?? null,
        knowledgeTitle: knowledge?.title ?? null,
        provider: nestedString(notes, 'aiProvenance', 'provider'),
        generatorModel: nestedString(notes, 'aiProvenance', 'model'),
        verifierProvider: nestedString(notes, 'verifier', 'provider'),
        verifierModel: nestedString(notes, 'verifier', 'model'),
        verifierReason: nestedString(notes, 'verifier', 'reason') || item.rejectedReason,
      }
    })
    const candidates = questions.filter((item) => ['APPROVED', 'PENDING_REVIEW'].includes(item.status) && String(item.qualityFlags || '').includes('SOURCE_GROUNDED'))
    const selection = selectUnitExamQuestionsApprovedFirst(candidates.map((item) => ({ id: item.id, status: item.status, qualityFlags: item.qualityFlags })), requiredQuestions)
    const grouped = groupByStatus(questions)
    return NextResponse.json({
      unit: { id: unit.id, title: unit.title, programId: unit.programId },
      requiredQuestions,
      readyToBuild: selection.readyToBuild,
      publishable: selection.publishable,
      counts: {
        APPROVED: grouped.APPROVED.length,
        PENDING_REVIEW: grouped.PENDING_REVIEW.length,
        REJECTED: grouped.REJECTED.length,
        total: items.length,
      },
      questions: grouped,
      exam: unit.exam ? { id: unit.exam.id, title: unit.exam.title, status: unit.exam.status, questionsCount: unit.exam._count.questions } : null,
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit questions GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل أسئلة الوحدة' }, { status: 500 })
  }
}
