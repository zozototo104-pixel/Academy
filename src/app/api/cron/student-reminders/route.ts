import { NextRequest, NextResponse } from 'next/server'
import { redactDeep } from '@/lib/secret-crypto'
import { processDailyReminders } from '@/lib/student-reminders'
import { processInactivityFollowUps } from '@/lib/student-follow-up'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET /api/cron/student-reminders — المحرك اليومي: تذكير بالمهام المعلقة حسب
// القرب/التأخر + تنبيه آخر 10 أيام + إغلاق البرنامج عند انتهاء المدة مع رصد الدرجة.
// قنوات التذكير: منصة + إيميل فقط، أبدًا واتساب.
// يعمل معه في نفس التشغيل محرك متابعة الغياب (خدمة المتابعة): غياب 3 أيام
// متتالية → رسالة متابعة (منصة + إيميل + واتساب بقرار خاص بهذه الخدمة)،
// وبعد 3 رسائل يتوقف الإرسال ويصبح الطالب «يحتاج تدخل». فشل محرك المتابعة
// لا يُفشل التذكيرات.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  try {
    const stats = await processDailyReminders()
    let followUp: Awaited<ReturnType<typeof processInactivityFollowUps>> | null = null
    try {
      followUp = await processInactivityFollowUps()
    } catch (e) {
      console.error('inactivity follow-up cron error', e)
    }
    return NextResponse.json(redactDeep({ ok: true, ...stats, followUp }))
  } catch (e) {
    console.error('student reminders cron error', e)
    return NextResponse.json(redactDeep({ error: 'تعذر تنفيذ التذكيرات اليومية' }), { status: 500 })
  }
}
