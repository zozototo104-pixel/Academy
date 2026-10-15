import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { ensureDemoThesisStudent } from '@/lib/demo-thesis'

function demoThesisEnabled() {
  if (process.env.VERCEL_ENV !== 'production') return true
  return ['1', 'true', 'yes'].includes(String(process.env.ENABLE_DEMO_THESIS || '').trim().toLowerCase())
}

export async function POST() {
  try {
    const admin = await requireAdmin()
    if (!demoThesisEnabled()) {
      return NextResponse.json({ error: 'الطالب التجريبي غير مفعل في بيئة الإنتاج' }, { status: 403 })
    }
    await ensureCoreSeed(true)
    const demo = await ensureDemoThesisStudent({ resetDefense: true, actor: admin })

    return NextResponse.json({
      ok: true,
      ...demo,
      loginUrl: '/?view=dashboard',
      note: 'سجّل دخولك بهذا الطالب، ثم افتح بوابة الطالب ← بحث التخرج ← دخول قاعة المناقشة. القاعة مفتوحة فوراً لأن موعدها مضبوط قبل دقيقة واحدة.',
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة لتجهيز الطالب التجريبي' }, { status: 403 })
    }
    console.error('demo thesis setup error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تجهيز الطالب التجريبي للمناقشة' }, { status: 500 })
  }
}
