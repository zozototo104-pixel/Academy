import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { decideReopenAppeal } from '@/lib/reopen-appeals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إدارة التماسات إعادة الفتح (المرحلة 4): قائمة + بتّ. البتّ مشروط
// بالحالة داخل المكتبة — قراران متزامنان ينجح أحدهما فقط.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const status = req.nextUrl.searchParams.get('status') || undefined
    const appeals = await (db as any).reopenAppeal.findMany({
      where: { ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }).catch(() => [])
    return NextResponse.json({ ok: true, appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تحميل الالتماسات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const result = await decideReopenAppeal(db, {
      appealId: String(body?.appealId || ''),
      actor: { id: admin.id },
      approve: body?.approve === true,
      note: body?.note ? String(body.note) : null,
    })
    if (!result.ok) {
      const status = result.code === 'FORBIDDEN' ? 403 : result.code === 'APPEAL_NOT_FOUND' ? 404 : result.code === 'APPEAL_ALREADY_DECIDED' ? 409 : 400
      const messages: Record<string, string> = {
        FORBIDDEN: 'صلاحية إدارية مطلوبة للبتّ في الالتماسات.',
        APPEAL_NOT_FOUND: 'الالتماس غير موجود.',
        APPEAL_ALREADY_DECIDED: 'حُسم هذا الالتماس من جلسة أخرى.',
        INVALID_INPUT: 'بيانات البتّ ناقصة.',
      }
      return NextResponse.json({ error: messages[result.code] || 'تعذر البتّ في الالتماس', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, appeal: result.appeal })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin reopen-appeal decide error:', e)
    return NextResponse.json({ error: 'تعذر البتّ في الالتماس' }, { status: 500 })
  }
}
