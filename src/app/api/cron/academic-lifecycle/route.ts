import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { dispatchOutboxBatch } from '@/lib/outbox'
import { escalateOverdueReopenAppeals } from '@/lib/reopen-appeals'
import { lapseOverdueMercy } from '@/lib/mercy'
import { scanDeadlineWarnings } from '@/lib/lifecycle-scans'
import { materializeDeadlineRaises, reconcileReadyGraduationNotices } from '@/lib/semester-decision'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET|POST /api/cron/academic-lifecycle — موزّع دورة الحياة الأكاديمية
// (المرحلة 6): يرسل أحداث الصادر المعلّقة (منصة بلا تكرار مضمون +
// بريد بمحاولات موثّقة)، يصعّد التماسات إعادة الفتح المتأخرة (دون
// رفض تلقائي أبدًا)، يُسقط أنشطة الاسترحام المنتهية مهلتها، ويسجّل
// تحذيرات المواعيد النهائية قبل يومين من نهاية النوافذ.
async function run(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const dispatch = await dispatchOutboxBatch(db as any).catch(() => ({ platformSent: 0, emailsSent: 0, emailsFailed: 0 }))
  const escalated = await escalateOverdueReopenAppeals(db as any).catch(() => 0)
  const deadlineRaises = await materializeDeadlineRaises(db as any).catch((error) => {
    console.error('semester deadline referral failed', error)
    return 0
  })
  // A ready graduation record may predate the student's last-semester
  // raise; reconcile the official admin notice only AFTER that gate.
  const readyGraduationNotices = await reconcileReadyGraduationNotices(db as any).catch((error) => {
    console.error('graduation notice reconciliation failed', error)
    return 0
  })
  const lapsed = await lapseOverdueMercy(db as any).catch(() => 0)
  const warnings = await scanDeadlineWarnings(db as any).catch(() => ({ warned: 0, scanned: 0 }))
  // Dispatch newly queued deadline/graduation notices in this round.
  if (warnings.warned > 0 || deadlineRaises > 0 || readyGraduationNotices > 0) {
    await dispatchOutboxBatch(db as any).catch((error) => console.error('academic outbox dispatch failed', error))
  }
  return NextResponse.json({ ok: true, dispatch, escalated, deadlineRaises, readyGraduationNotices, lapsed, warnings })
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
