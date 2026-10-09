import { NextRequest, NextResponse } from 'next/server'
import { claimAiHealthRun } from '@/lib/ai-health'
import { redactDeep } from '@/lib/secret-crypto'
import { textAiCheckAllModelHealth } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const claimed = await claimAiHealthRun()
  if (!claimed) return NextResponse.json(redactDeep({ ok: true, skipped: true }))
  const result = await textAiCheckAllModelHealth({ maxMs: 40_000 })
  return NextResponse.json(redactDeep({ ok: true, ...result }))
}
