import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  getQuestionRecheckOverview,
  QUESTION_RECHECK_RUN_BATCH_SIZE,
} from '@/lib/question-recheck-admin'
import { runQuestionRecheckBatch } from '@/lib/question-recheck-runner'

export async function GET() {
  try {
    await requireAdmin()
    return NextResponse.json(await getQuestionRecheckOverview())
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل طابور إعادة التدقيق' }, { status: 500 })
  }
}

export async function POST() {
  try {
    await requireAdmin()
    const batch = await runQuestionRecheckBatch({ limit: QUESTION_RECHECK_RUN_BATCH_SIZE })
    const overview = await getQuestionRecheckOverview()
    return NextResponse.json({ batch, overview })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تشغيل دفعة إعادة التدقيق' }, { status: 500 })
  }
}
