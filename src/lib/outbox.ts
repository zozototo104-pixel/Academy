import { db } from './db'
import { isAactTestEmail } from './prod-safety'
import { emailTemplate, sendEmailDetailed } from './mailer'

// سجل الأحداث الصادرة (المرحلتان 4 و6): إشعارات دورة حياة الطالب لا
// تُرسل نداءات نارية مباشرة؛ تُحفظ كحدث داخل نفس معاملة تغيير الحالة
// بمفتاح عدم تكرار فريد، ويوزّعها الموزّع لاحقًا:
// - داخل المنصة: إنشاء الإشعارات وانقلاب الحدث إلى SENT بمعاملة واحدة
//   ⟹ عدم تكرار مضمون بمفتاح الحدث.
// - البريد: محاولات موثّقة بحالة مستقلة؛ قد يصل مرتين في انقطاع نادر
//   بعد قبول المزوّد وقبل تسجيل النجاح — لا يُدّعى له «مرة واحدة».
type AnyClient = any

export type OutboxEvent = {
  key: string
  kind: string
  recipientUserId?: string | null
  recipientRole?: 'ADMINS' | null
  title: string
  body: string
  link?: string | null
}

export async function enqueueOutbox(client: AnyClient, evt: OutboxEvent) {
  const store = (client as AnyClient)?.notificationOutbox
  if (!store?.create) return null
  try {
    return await store.create({
      data: {
        idempotencyKey: evt.key,
        kind: evt.kind,
        recipientUserId: evt.recipientUserId ?? null,
        recipientRole: evt.recipientRole ?? null,
        title: evt.title,
        body: evt.body,
        link: evt.link ?? null,
      },
    })
  } catch (e: any) {
    // مفتاح مكرر = الحدث مسجّل أصلًا: عدم التكرار يعمل، لا خطأ.
    if (e?.code === 'P2002' || /unique/i.test(String(e?.message || ''))) {
      return store.findUnique?.({ where: { idempotencyKey: evt.key } }).catch(() => null) ?? null
    }
    throw e
  }
}

async function resolveRecipients(client: AnyClient, row: any): Promise<Array<{ id: string; email: string | null; name: string | null }>> {
  if (row.recipientRole === 'ADMINS') {
    const admins = await client.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true, email: true, name: true },
    })
    return admins.filter((a: any) => !isAactTestEmail(a.email))
  }
  if (row.recipientUserId) {
    const user = await client.user.findUnique({
      where: { id: row.recipientUserId },
      select: { id: true, email: true, name: true },
    })
    if (!user || isAactTestEmail(user.email)) return []
    return [user]
  }
  return []
}

const MAX_EMAIL_ATTEMPTS = 5

export async function dispatchOutboxBatch(client: AnyClient = db, limit = 50): Promise<{ platformSent: number; emailsSent: number; emailsFailed: number }> {
  const store = (client as AnyClient)?.notificationOutbox
  if (!store?.findMany) return { platformSent: 0, emailsSent: 0, emailsFailed: 0 }
  let platformSent = 0
  let emailsSent = 0
  let emailsFailed = 0

  // ١) المنصة: إنشاء الإشعارات وانقلاب الحالة بمعاملة واحدة لكل حدث.
  const pending = await store.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  }).catch(() => [])
  for (const row of pending) {
    try {
      const recipients = await resolveRecipients(client, row)
      const delivered = await client.$transaction(async (tx: AnyClient) => {
        // Claim before creating notifications, with a conditional write inside
        // the same transaction. Concurrent dispatchers can see the same PENDING
        // row, but only one can transition it to SENT.
        const claim = await tx.notificationOutbox.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'SENT', sentAt: new Date(), ...(recipients.length ? {} : { emailStatus: 'SKIPPED' }) },
        })
        if (claim.count !== 1) return false
        if (recipients.length) {
          await tx.notification.createMany({
            data: recipients.map((r) => ({ userId: r.id, type: row.kind, title: row.title, body: row.body, link: row.link ?? undefined })),
          })
        }
        return true
      })
      if (delivered) platformSent++
    } catch (e) {
      // A failed transaction rolls back both the status change and all
      // notifications. Leave the event PENDING for the next cron run.
      console.error('outbox platform dispatch failed', row.id, e)
    }
  }

  // ٢) البريد: محاولات موثّقة للمنصّة المُسلَّمة التي بريدها لم يُحسم.
  const emailDue = await store.findMany({
    where: { status: 'SENT', emailStatus: { in: ['PENDING', 'FAILED'] }, emailAttempts: { lt: MAX_EMAIL_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  }).catch(() => [])
  for (const row of emailDue) {
    // A lookup outage is not an empty recipient list: leave the email
    // PENDING/FAILED for the next cron tick and continue with other events.
    const resolved = await resolveRecipients(client, row).catch((e: unknown) => {
      console.error('outbox email recipient lookup failed', row.id, e)
      return null
    })
    if (resolved === null) continue
    const recipients = resolved.filter((r) => r.email)
    if (!recipients.length) {
      await store.update({ where: { id: row.id }, data: { emailStatus: 'SKIPPED' } }).catch(() => {})
      continue
    }
    const outcomes: string[] = []
    let lastError: string | null = null
    for (const r of recipients) {
      const status = await sendEmailDetailed({
        to: r.email as string,
        subject: row.title,
        event: row.kind,
        html: emailTemplate(row.title, row.body),
      }).catch((e: any) => { lastError = String(e?.message || e); return 'FAILED' as const })
      outcomes.push(status)
      if (status === 'FAILED') lastError = lastError || 'send failed'
    }
    // الحالة النهائية بأمانة: فشل أي مستلم = FAILED (يُعاد لاحقًا)،
    // تخطّي المزوّد غير المهيأ = SKIPPED نهائي موثّق، غير ذلك SENT.
    const finalStatus = outcomes.includes('FAILED') ? 'FAILED' : outcomes.includes('SKIPPED') ? 'SKIPPED' : 'SENT'
    if (finalStatus === 'SENT') emailsSent++
    else if (finalStatus === 'FAILED') emailsFailed++
    await store.update({
      where: { id: row.id },
      data: {
        emailStatus: finalStatus,
        emailAttempts: { increment: 1 },
        ...(lastError ? { lastError } : {}),
      },
    }).catch(() => {})
  }
  return { platformSent, emailsSent, emailsFailed }
}
