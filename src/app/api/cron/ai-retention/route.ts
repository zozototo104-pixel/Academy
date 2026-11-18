import { NextRequest, NextResponse } from 'next/server'
import { cleanupOldAiConversations } from '@/lib/ai-retention'
import { cleanupExpiredAgentUploads } from '@/lib/agent-upload-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.BACKUP_CRON_SECRET || ''
  // فشل مُغلق كسائر مسارات الكرون: غياب السر يعني الرفض لا الفتح —
  // الفتح كان يتيح لأي زائر بلا دخول تشغيل حذف محادثات الذكاء القديمة.
  if (!secret) return false
  const header = req.headers.get('authorization') || req.headers.get('x-cron-secret') || ''
  return header === `Bearer ${secret}` || header === secret
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  const result = await cleanupOldAiConversations()
  // Existing authenticated daily retention job also reclaims expired agent
  // staging objects (token TTL 24h). This never touches saved documents.
  const agentUploads = await cleanupExpiredAgentUploads().catch((error) => {
    console.error('[agent-upload] cron cleanup failed', error)
    return { checked: 0, removed: 0, linked: 0, failed: 1 }
  })
  return NextResponse.json({ ok: true, ...result, agentUploads })
}
