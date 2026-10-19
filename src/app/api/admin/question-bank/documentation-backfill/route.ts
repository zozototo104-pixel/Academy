import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { backfillQuestionBankAcademicFields } from '@/lib/question-bank-documentation'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = String(body?.programId || '').trim()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const result = await backfillQuestionBankAcademicFields(programId, 48_000)
    return NextResponse.json(result)
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank documentation backfill error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر استكمال توثيق بنك الأسئلة' }, { status: 500 })
  }
}
