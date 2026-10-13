import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseDetails(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 1000) } }
}

function maskPhone(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.includes('***')) return raw
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 5) return '***'
  return `${raw.slice(0, 3)}***${raw.slice(-2)}`
}

export async function GET() {
  try {
    await requireAdmin()
    const rows = await db.auditLog.findMany({
      where: { action: 'WHATSAPP_AI_FALLBACK_SENT' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, entityId: true, details: true, createdAt: true },
    })
    return NextResponse.json({
      failures: rows.map((row) => {
        const details: any = parseDetails(row.details)
        return {
          id: row.id,
          at: row.createdAt,
          conversationKey: row.entityId,
          from: maskPhone(details.from),
          provider: details.provider || null,
          model: details.model || null,
          elapsedMs: details.elapsedMs || null,
          failureReason: details.failureReason || details.reason || null,
          classifierResult: details.classifierResult || null,
        }
      }),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin whatsapp failures error:', e)
    return NextResponse.json({ error: 'تعذر تحميل إخفاقات الواتساب' }, { status: 500 })
  }
}
