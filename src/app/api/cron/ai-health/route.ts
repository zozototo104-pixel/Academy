import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { textAiCheckAllModelHealth } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const lastRun = await db.setting.findUnique({ where: { key: 'AI_HEALTH_LAST_RUN' } }).catch(() => null)
  const lastRunAt = Number(lastRun?.value || 0) || 0
  if (Date.now() - lastRunAt < 60 * 60 * 1000) {
    return NextResponse.json({ ok: true, skipped: true, lastRunAt })
  }
  await db.setting.upsert({ where: { key: 'AI_HEALTH_LAST_RUN' }, create: { key: 'AI_HEALTH_LAST_RUN', value: String(Date.now()) }, update: { value: String(Date.now()) } }).catch(() => {})
  const result = await textAiCheckAllModelHealth({ maxMs: 40_000 })
  return NextResponse.json({ ok: true, ...result })
}
