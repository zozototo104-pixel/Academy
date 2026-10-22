import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redactDeep } from '@/lib/secret-crypto'
import { isLecturesEnabled, isLecturesEnabledForProgram } from '@/lib/lectures/config'
import { notifyProgramStudents } from '@/lib/lectures/manage'
import { selectDueReminders } from '@/lib/lectures/reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function formatWhen(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)
  } catch {
    return date.toISOString()
  }
}

// GET /api/cron/lecture-reminders — تذكيرات المحاضرات (قبل 24 ساعة وقبل
// 15 دقيقة). كل تذكير يُطالَب به ذرّيًا قبل إرساله فلا يتكرر أبدًا مهما
// تكرر تشغيل البوابة أو تداخل.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  if (!isLecturesEnabled()) {
    return NextResponse.json(redactDeep({ ok: true, skipped: 'lectures-disabled' }))
  }

  type CronSession = {
    id: string
    status: string
    title: string
    startsAt: Date
    endsAt: Date
    reminder24hSentAt: Date | null
    reminder15mSentAt: Date | null
    series: { programId: string; timezone: string; program: { titleAr: string } }
  }

  const now = new Date()
  const candidates = (await db.lectureSession.findMany({
    where: {
      status: 'SCHEDULED',
      startsAt: { lte: new Date(now.getTime() + 24 * 3_600_000) },
      endsAt: { gte: new Date(now.getTime() - 15 * 60_000) },
      OR: [{ reminder24hSentAt: null }, { reminder15mSentAt: null }],
    },
    include: {
      series: {
        select: {
          programId: true,
          timezone: true,
          program: { select: { titleAr: true } },
        },
      },
    },
  })) as unknown as CronSession[]
  const eligible = candidates.filter((s) => isLecturesEnabledForProgram(s.series.programId))
  const due = selectDueReminders(eligible, now)
  const byId = new Map(eligible.map((s) => [s.id, s]))

  let sent24h = 0
  let sent15m = 0
  for (const item of due) {
    const session = byId.get(item.sessionId)
    if (!session) continue
    // المطالبة الذرية: التحديث ينجح لمُشغّل واحد فقط (الحقل كان فارغًا).
    const claim =
      item.kind === 'BEFORE_24H'
        ? await db.lectureSession.updateMany({
            where: { id: session.id, reminder24hSentAt: null },
            data: { reminder24hSentAt: now },
          })
        : await db.lectureSession.updateMany({
            where: { id: session.id, reminder15mSentAt: null },
            data: { reminder15mSentAt: now },
          })
    if (claim.count !== 1) continue

    const when = formatWhen(session.startsAt, session.series.timezone)
    const is24h = item.kind === 'BEFORE_24H'
    await notifyProgramStudents(session.series.programId, {
      type: is24h ? 'LECTURE_REMINDER_24H' : 'LECTURE_REMINDER_15M',
      title: is24h ? 'تذكير بمحاضرة' : 'محاضرتك تبدأ قريبًا',
      body: is24h
        ? `تذكير: محاضرة «${session.title}» في برنامج «${session.series.program.titleAr}» تبدأ في ${when}.`
        : `محاضرة «${session.title}» في برنامج «${session.series.program.titleAr}» تبدأ في ${when} — الانضمام يفتح قبل الموعد بـ 15 دقيقة.`,
      emailSubject: is24h ? 'تذكير بمحاضرة في برنامجك' : 'محاضرتك تبدأ قريبًا',
    })
    if (is24h) sent24h += 1
    else sent15m += 1
  }

  return NextResponse.json(redactDeep({ ok: true, sent24h, sent15m }))
}
