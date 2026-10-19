import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { backfillProgramExamAcademicFields, syncProgramExamQuestionsFromBank } from '@/lib/program-exam-assembly'
import { calculateProgramExamAcademicMissingCounts } from '@/lib/program-exam-publication-readiness'

export const maxDuration = 60

async function academicCounts(examId: string) {
  const questions = await db.programQuestion.findMany({
    where: { examId, status: { not: 'REJECTED' } },
    select: {
      status: true,
      type: true,
      sourceEvidence: true,
      sourceBookTitle: true,
      sourceLocator: true,
      cognitiveSkill: true,
      difficulty: true,
      correctRationale: true,
      distractorRationales: true,
      qualityFlags: true,
      knowledgeItemId: true,
    },
  })
  return calculateProgramExamAcademicMissingCounts(questions)
}

async function activeBackfillLock(examId: string) {
  const lock = await db.setting.findUnique({ where: { key: `PROGRAM_EXAM_BACKFILL_LOCK:${examId}` }, select: { value: true } })
  const until = Date.parse(lock?.value || '')
  return Number.isFinite(until) && until > Date.now()
}

export async function POST(_req: NextRequest, context: any) {
  try {
    await requireAdmin()
    const params = await context?.params
    const examId = String(params?.examId || '')
    const exam = await db.programExam.findUnique({ where: { id: examId }, select: { id: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })

    if (await activeBackfillLock(examId)) {
      const counts = await academicCounts(examId)
      return NextResponse.json({ filled: 0, aiFailed: 0, ...counts, done: counts.remaining === 0, locked: true })
    }

    const startedAt = Date.now()
    const deadlineMs = startedAt + 48_000
    let filled = await syncProgramExamQuestionsFromBank(examId)
    let aiFailed = 0
    let counts = await academicCounts(examId)

    while (counts.remaining > 0 && Date.now() - startedAt < 45_000) {
      const result = await backfillProgramExamAcademicFields(examId, { maxBatches: 2 })
      if (result.skipped === 'LOCKED') {
        counts = await academicCounts(examId)
        return NextResponse.json({ filled, aiFailed, ...counts, done: counts.remaining === 0, locked: true })
      }
      filled += result.filled || 0
      aiFailed += result.aiFailed || 0
      counts = await academicCounts(examId)
      if (result.batchesRun === 0 && (result.filled || 0) === 0) break
    }

    return NextResponse.json({ filled, aiFailed, ...counts, done: counts.remaining === 0 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program exam academic backfill error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر استكمال البيانات الأكاديمية' }, { status: 500 })
  }
}
