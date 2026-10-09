import { NextResponse } from 'next/server'
import { runNextBookReadJobStep } from '@/lib/book-reader'
import { runNextBookKnowledgeEnrichmentJobStep } from '@/lib/book-knowledge-enrichment'
import { runNextQuestionBankGenerationJobStep } from '@/lib/question-bank-job'
import { claimAiHealthRun } from '@/lib/ai-health'
import { textAiCheckAllModelHealth } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: Request) {
  const auth = req.headers.get('authorization') || ''
  const expected = process.env.CRON_SECRET
  if (!expected || auth !== `Bearer ${expected}`) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const endAt = Date.now() + 240_000
  const outcomes: { jobId: string; outcome: string }[] = []
  if (Date.now() < endAt - 90_000 && await claimAiHealthRun()) {
    const health = await textAiCheckAllModelHealth({ maxMs: 40_000 }).catch((error) => ({ checked: 0, results: [], error: String((error as any)?.message || error) }))
    outcomes.push({ jobId: 'AI_MODEL_HEALTH', outcome: `CHECKED_${health.checked}` })
  }

  while (Date.now() < endAt) {
    const result = await runNextBookReadJobStep(new Date(endAt))
    if (!result) break
    outcomes.push(result)
    if (result.outcome === 'LOCKED') break
    if (['COMPLETED', 'PAUSED', 'FAILED'].includes(result.outcome)) continue
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  while (Date.now() < endAt) {
    const result = await runNextBookKnowledgeEnrichmentJobStep(new Date(endAt))
    if (!result) break
    outcomes.push(result)
    if (result.outcome === 'LOCKED') break
    if (['COMPLETED', 'PAUSED', 'FAILED'].includes(result.outcome)) continue
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  while (Date.now() < endAt) {
    const result = await runNextQuestionBankGenerationJobStep(new Date(endAt))
    if (!result) break
    outcomes.push(result)
    if (result.outcome === 'LOCKED') break
    if (['COMPLETED', 'FAILED', 'PAUSED'].includes(result.outcome)) continue
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  return NextResponse.json({ ok: true, outcomes })
}
