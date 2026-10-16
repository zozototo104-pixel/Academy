import { NextRequest, NextResponse } from 'next/server'
import { cleanupOldAiConversations } from '@/lib/ai-retention'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.BACKUP_CRON_SECRET || ''
  if (!secret) return true
  const header = req.headers.get('authorization') || req.headers.get('x-cron-secret') || ''
  return header === `Bearer ${secret}` || header === secret
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  const result = await cleanupOldAiConversations()
  return NextResponse.json({ ok: true, ...result })
}
