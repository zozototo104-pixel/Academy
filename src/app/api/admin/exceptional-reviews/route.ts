import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { decideExceptionalReview } from '@/lib/exceptional-review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إدارة المراجعات الاستثنائية (المرحلة 4): قائمة + بتّ موثّق.
export async function GET() {
  try {
    await requireAdmin()
    const reviews = await (db as any).exceptionalReview.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }).catch(() => [])
    return NextResponse.json({ ok: true, reviews })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const result = await decideExceptionalReview(db, {
      reviewId: String(body?.reviewId || ''),
      actor: { id: admin.id },
      note: String(body?.note || ''),
    })
    if (!result.ok) {
      const messages: Record<string, string> = {
        FORBIDDEN: 'صلاحية إدارية مطلوبة.',
        REVIEW_NOT_FOUND: 'الطلب غير موجود.',
        REVIEW_ALREADY_DECIDED: 'حُسم هذا الطلب من جلسة أخرى.',
        INVALID_INPUT: 'القرار الموثّق مطلوب — اكتب نص القرار.',
      }
      const status = result.code === 'REVIEW_NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : result.code === 'REVIEW_ALREADY_DECIDED' ? 409 : 400
      return NextResponse.json({ error: messages[result.code] || 'تعذر البتّ', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, review: result.review })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin exceptional-review decide error:', e)
    return NextResponse.json({ error: 'تعذر البتّ' }, { status: 500 })
  }
}
