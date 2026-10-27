import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { redactDeep } from '@/lib/secret-crypto'
import { emailAdminMessagesDigest } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UNREAD_AFTER_MS = 60 * 60 * 1000

// GET /api/cron/admin-message-digest — تذكير بالبريد لرسائل الإدارة غير المقروءة.
// Runs every 30 minutes (vercel.json); emails only admin-scope messages from ADMIN
// senders older than 1 hour that were never emailed. One digest email per student
// per run. A message counts as unread only while its student still has an unread
// ADMIN_MESSAGE notification pointing at that thread; emailSentAt is set only after
// a successful send, so a failed send retries on the next run.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const cutoff = new Date(Date.now() - UNREAD_AFTER_MS)
  const overdue = await db.supervisorChannelMessage.findMany({
    where: { scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, createdAt: { lt: cutoff } },
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
    const sent = await emailAdminMessagesDigest(student.email, student.name, group.messages)
    if (!sent) continue
    await db.supervisorChannelMessage.updateMany({
      where: { id: { in: group.messages.map((m: any) => m.id) } },
      data: { emailSentAt: new Date() },
    })
    emailedStudents += 1
    emailedMessages += group.messages.length
  }
  await audit({ name: 'cron' }, 'ADMIN_MESSAGE_DIGEST', 'SupervisorChannelMessage', null, `students=${emailedStudents} messages=${emailedMessages} overdue=${overdue.length}`).catch(() => {})
  return NextResponse.json(redactDeep({ ok: true, emailedStudents, emailedMessages, overdue: overdue.length }))
}
