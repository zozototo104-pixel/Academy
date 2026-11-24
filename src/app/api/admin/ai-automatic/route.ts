import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { textAiAutomaticSnapshot } from '@/lib/text-ai'
import { refreshAutomaticCatalog } from '@/lib/ai-auto-refresh'

export const runtime = 'nodejs'

export async function GET() {
  try {
    await requireAdmin()
    return NextResponse.json(await textAiAutomaticSnapshot(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'UNAUTHORIZED'
    return NextResponse.json({ error: unauthorized ? 'صلاحيات الإدارة مطلوبة' : 'تعذر تحميل قرارات الإدارة التلقائية' }, { status: unauthorized ? 401 : 500 })
  }
}

export async function POST() {
  try {
    await requireAdmin()
    return NextResponse.json(await refreshAutomaticCatalog())
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'UNAUTHORIZED'
    return NextResponse.json({ error: unauthorized ? 'صلاحيات الإدارة مطلوبة' : 'تعذر تحديث كتالوج النماذج' }, { status: unauthorized ? 401 : 500 })
  }
}
