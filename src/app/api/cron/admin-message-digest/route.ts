import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { redactDeep } from '@/lib/secret-crypto'
import { emailAdminMessagesDigest } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UNREAD_AFTER_MS = 60 * 60 * 1000
const DIGEST_CLAIM_STALE_MS = 10 * 60 * 1000
// E02: مطالبة الملخص بحقول مستقلة (emailClaimId/emailClaimLeaseUntil)
// وemailSentAt لا تحمل إلا لحظة التسليم الحقيقية.
// القراءة الانتقالية التالية للترميز القديم فقط: مطالبات كُتبت قبل E02
// كتاريخ مستقبلي (~100 سنة) داخل emailSentAt تُحترم حتى تنقضي مهلتها
// بحسب ختمها الأصلي ثم تُتبنّى بالحقول الجديدة؛ لا تُكتب مطالبة جديدة
// بهذا الترميز أبدًا، ويموت من تلقاء نفسه بانقضاء آخر مطالبة قديمة.
const DIGEST_CLAIM_OFFSET_MS = 100 * 365 * 24 * 60 * 60 * 1000
const DIGEST_CLAIM_MIN = new Date('2100-01-01T00:00:00.000Z')
function staleDigestClaim(now = Date.now()) {
  return { gt: DIGEST_CLAIM_MIN, lt: new Date(now + DIGEST_CLAIM_OFFSET_MS - DIGEST_CLAIM_STALE_MS) }
}
// رسالة قابلة للمطالبة الآن: غير مُسلَّمة (أو مطالَبة بالترميز القديم
// وانقضت مهلتها) وليست تحت مطالبة حقول جديدة حيّة.
function digestClaimableWhere(now = new Date()) {
  return {
    OR: [{ emailSentAt: null }, { emailSentAt: staleDigestClaim(now.getTime()) }],
    AND: [{ OR: [{ emailClaimLeaseUntil: null }, { emailClaimLeaseUntil: { lt: now } }] }],
  }
}

// GET /api/cron/admin-message-digest — تذكير بالبريد لرسائل الإدارة غير المقروءة.
// Runs every 30 minutes (vercel.json); emails only admin-scope messages from ADMIN
// senders older than 1 hour that were never emailed. One digest email per student
// per run. A message counts as unread only while its student still has an unread
// ADMIN_MESSAGE notification pointing at that thread. Each group is claimed
// atomically (dedicated claim fields set by a conditional updateMany —
// the lecture reminders pattern) before its email is sent, so overlapping
// runs cannot double-send; a failed send releases the claim, so it retries
// on the next run.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const cutoff = new Date(Date.now() - UNREAD_AFTER_MS)
  const overdue = await db.supervisorChannelMessage.findMany({
    where: {
      scope: 'ADMIN', senderRole: 'ADMIN', createdAt: { lt: cutoff },
      ...digestClaimableWhere(),
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { id: true, admissionId: true, studentId: true, content: true, createdAt: true },
  })
  const groups = new Map<string, { admissionId: string; studentId: string; messages: typeof overdue }>()
  for (const m of overdue as any[]) {
    const key = `${m.studentId}:${m.admissionId}`
    if (!groups.has(key)) groups.set(key, { admissionId: m.admissionId, studentId: m.studentId, messages: [] })
    groups.get(key)!.messages.push(m)
  }
  let emailedStudents = 0
  let emailedMessages = 0
  for (const group of groups.values()) {
    const unread = await db.notification.findFirst({
      where: { userId: group.studentId, type: 'ADMIN_MESSAGE', read: false, link: `admin-messages:${group.admissionId}` },
      select: { id: true },
    })
    if (!unread) continue
    const student = await db.user.findUnique({ where: { id: group.studentId }, select: { email: true, name: true } }).catch(() => null)
    if (!student?.email) continue
    // المطالبة الذرية قبل الإرسال (نمط تذكيرات المحاضرات): التحديث
    // المشروط بحقول المطالبة ينجح لمُشغّل واحد فقط لكل مجموعة؛ مطالبة
    // جزئية تعني تداخلًا مع تشغيل آخر فتُحرَّر الصفوف المأخوذة بمعرّف
    // مطالبتنا وتُتخطى المجموعة. emailSentAt لا تُمسّ إلا عند التسليم.
    const messageIds = group.messages.map((m: any) => m.id)
    const claimId = `digest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const claim = await db.supervisorChannelMessage.updateMany({
      where: { id: { in: messageIds }, ...digestClaimableWhere() },
      data: { emailClaimId: claimId, emailClaimLeaseUntil: new Date(Date.now() + DIGEST_CLAIM_STALE_MS) },
    })
    const releaseClaim = () =>
      db.supervisorChannelMessage.updateMany({
        where: { id: { in: messageIds }, emailClaimId: claimId },
        data: { emailClaimId: null, emailClaimLeaseUntil: null },
      }).catch(() => {})
    if (claim.count !== messageIds.length) {
      await releaseClaim()
      continue
    }
    let sent = false
    try {
      sent = await emailAdminMessagesDigest(student.email, student.name, group.messages)
    } catch {
      sent = false
    }
    if (!sent) {
      // فشل الإرسال يحرّر المطالبة فيُعاد على التشغيل التالي كما كان.
      await releaseClaim()
      continue
    }
    // Commit the actual delivery time only after the mailer accepts it.
    // A crashed sender leaves its claim fields to be recovered by the
    // next cron run after the lease expires.
    const finalized = await db.supervisorChannelMessage.updateMany({
      where: { id: { in: messageIds }, emailClaimId: claimId },
      data: { emailSentAt: new Date(), emailClaimId: null, emailClaimLeaseUntil: null },
    })
    if (finalized.count !== messageIds.length) {
      console.error('Admin digest finalization lost its email claim', { count: finalized.count, wanted: messageIds.length })
      continue
    }
    emailedStudents += 1
    emailedMessages += group.messages.length
  }
  await audit({ name: 'cron' }, 'ADMIN_MESSAGE_DIGEST', 'SupervisorChannelMessage', null, `students=${emailedStudents} messages=${emailedMessages} overdue=${overdue.length}`).catch(() => {})
  return NextResponse.json(redactDeep({ ok: true, emailedStudents, emailedMessages, overdue: overdue.length }))
}
