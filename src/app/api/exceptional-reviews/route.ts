import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { openExceptionalReview } from '@/lib/exceptional-review'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// مراجعة أكاديمية استثنائية (المرحلة 4): يفتحها الطالب لفصل مغلق،
// وتُبتّ إداريًا بقرار موثّق — لا تعيد فتح الفصل ولا تغيّر درجة بذاتها.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => ({}))
    const result = await openExceptionalReview(db, {
      userId: user.id,
      programId: String(body?.programId || ''),
      semester: Number(body?.semester),
      reason: String(body?.reason || ''),
    })
    if (!result.ok) {
      const messages: Record<string, string> = {
        SEMESTER_NOT_CLOSED: 'المراجعة الاستثنائية متاحة بعد إغلاق الفصل واعتماد نتيجته.',
        REVIEW_ALREADY_OPEN: 'لديك طلب مراجعة استثنائية مفتوح لهذا الفصل بالفعل.',
        ENROLLMENT_NOT_FOUND: 'لا تسجيل مطابقًا في هذا البرنامج.',
        INVALID_INPUT: 'اكتب سبب المراجعة بوضوح وحدّد الفصل.',
      }
      const status = result.code === 'ENROLLMENT_NOT_FOUND' ? 404 : result.code === 'REVIEW_ALREADY_OPEN' ? 409 : 400
      return NextResponse.json({ error: messages[result.code] || 'تعذر فتح الطلب', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, review: result.review })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    console.error('exceptional-review POST error:', e)
    return NextResponse.json({ error: 'تعذر فتح الطلب' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const user = await requireUser()
    const reviews = await (db as any).exceptionalReview.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => [])
    return NextResponse.json({ ok: true, reviews })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل الطلبات' }, { status: 500 })
  }
}
