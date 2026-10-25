import { NextRequest, NextResponse } from 'next/server'
import { redactDeep } from '@/lib/secret-crypto'
import { processDailyReminders } from '@/lib/student-reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET /api/cron/student-reminders — المحرك اليومي: تذكير بالمهام المعلقة حسب
// القرب/التأخر + تنبيه آخر 10 أيام + إغلاق البرنامج عند انتهاء المدة مع رصد الدرجة.
// قنوات: منصة + إيميل فقط، أبدًا واتساب.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  try {
    const stats = await processDailyReminders()
    return NextResponse.json(redactDeep({ ok: true, ...stats }))
  } catch (e) {
    console.error('student reminders cron error', e)
    return NextResponse.json(redactDeep({ error: 'تعذر تنفيذ التذكيرات اليومية' }), { status: 500 })
  }
}
