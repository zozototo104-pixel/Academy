import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { submitMercyActivity } from '@/lib/mercy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// تسليم النشاط العلاجي — قبل موعده فقط؛ التأخر ينقضي به الطلب.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => ({}))
    const result = await submitMercyActivity(db, {
      mercyId: String(body?.mercyId || ''),
      userId: user.id,
      text: String(body?.text || ''),
    })
    if (!result.ok) {
      const messages: Record<string, string> = {
        MERCY_DEADLINE_PASSED: 'انتهت مهلة تسليم النشاط العلاجي؛ انقضى الطلب وتبقى نتيجة الفصل كما اعتُمدت.',
        MERCY_WRONG_STATE: 'لا نشاط مُسندًا بانتظار تسليمك حاليًا.',
        FORBIDDEN: 'هذا النشاط ليس لك.',
        MERCY_NOT_FOUND: 'الطلب غير موجود.',
        INVALID_INPUT: 'اكتب تسليمك قبل الإرسال.',
      }
      const status = result.code === 'MERCY_NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 409
      return NextResponse.json({ error: messages[result.code] || 'تعذر التسليم', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, mercy: result.mercy })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    console.error('mercy submit error:', e)
    return NextResponse.json({ error: 'تعذر التسليم' }, { status: 500 })
  }
}
