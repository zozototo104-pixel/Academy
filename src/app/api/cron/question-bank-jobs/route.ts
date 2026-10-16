import { NextRequest, NextResponse } from 'next/server'
import { runNextQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const endAt = Date.now() + 50_000
  const outcomes: { jobId: string; status: string }[] = []

  while (Date.now() < endAt - 5_000) {
    const job = await runNextQuestionBankGenerationJobStep()
    if (!job) break
    outcomes.push({ jobId: job.id, status: job.status })
    if (job.status !== 'QUEUED') break
  }

  return NextResponse.json({ ok: true, processed: outcomes.length, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
