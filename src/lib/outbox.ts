import { db } from './db'
import { isAactTestEmail } from './prod-safety'
import { emailTemplate, sendEmailDetailed } from './mailer'

// سجل الأحداث الصادرة (المرحلتان 4 و6): إشعارات دورة حياة الطالب لا
// تُرسل نداءات نارية مباشرة؛ تُحفظ كحدث داخل نفس معاملة تغيير الحالة
// بمفتاح عدم تكرار فريد، ويوزّعها الموزّع لاحقًا:
// - داخل المنصة: إنشاء الإشعارات وانقلاب الحدث إلى SENT بمعاملة واحدة
//   ⟹ عدم تكرار مضمون بمفتاح الحدث.
// - البريد: يُطالَب به ذرّيًا قبل الإرسال (انقلاب مشروط إلى SENDING مع
//   ختم وقت المطالبة) فلا يرسله موزّعان متزامنان؛ المطالبة التي لا تُحسم
//   خلال 10 دقائق (موزّع مات بعد قبول المزوّد وقبل تسجيل النتيجة) تصبح
//   قديمة وتُسترد — في تلك النافذة الضيقة فقط قد يصل البريد مرتين.
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

// مطالبة البريد: لا يوجد عمود updatedAt على صف الحدث، فيُحمل وقت
// المطالبة داخل lastError كختم «EMAIL_CLAIM:<ISO>» ريثما تُكتب النتيجة
// الحقيقية (نجاح يمسح الختم، وفشل يستبدله بنص الخطأ). المطالبة الأقدم
// من المهلة تُعدّ يتيمة — صاحبها مات قبل الحسم — وتُسترد بمطابقة الختم
// نفسه (CAS) حتى لا يسرق موزّعٌ مطالبةً حيّة من آخر.
const EMAIL_CLAIM_STALE_MS = 10 * 60 * 1000
const EMAIL_CLAIM_PREFIX = 'EMAIL_CLAIM:'
const EMAIL_SENT_IDS_PREFIX = 'EMAIL_SENT_IDS:'

// Preserve delivered recipient user IDs across retries and worker crashes.
// The legacy lastError column acts as a small durable checkpoint without
// changing already deployed database tables.
function deliveredEmailRecipientIds(lastError: unknown): Set<string> {
  const line = String(lastError || '').split('\n').find((part) => part.startsWith(EMAIL_SENT_IDS_PREFIX))
  if (!line) return new Set()
  try {
    const ids = JSON.parse(line.slice(EMAIL_SENT_IDS_PREFIX.length))
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length <= 128) : [])
  } catch { return new Set() }
}

function emailClaimMarker(now = new Date(), sentIds: ReadonlySet<string> = new Set()) {
  return `${EMAIL_CLAIM_PREFIX}${now.toISOString()}\n${EMAIL_SENT_IDS_PREFIX}${JSON.stringify([...sentIds].sort())}`
}

function emailClaimIsStale(row: any, now = Date.now()) {
  if (row?.emailStatus !== 'SENDING') return false
  const firstLine = String(row?.lastError || '').split('\n')[0]
  if (!firstLine.startsWith(EMAIL_CLAIM_PREFIX)) return true
  const claimedAt = Date.parse(firstLine.slice(EMAIL_CLAIM_PREFIX.length))
  return !Number.isFinite(claimedAt) || now - claimedAt > EMAIL_CLAIM_STALE_MS
}

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
  // تُرشَّح أيضًا صفوف SENDING (مطالبات سابقة) وتُفحص حداثتها بالحلقة.
  const emailDue = await store.findMany({
    where: {
      status: 'SENT',
      emailAttempts: { lt: MAX_EMAIL_ATTEMPTS },
      OR: [
        { emailStatus: { in: ['PENDING', 'FAILED'] } },
        { emailStatus: 'SENDING' },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  }).catch(() => [])
  for (const row of emailDue) {
    if (row.emailStatus === 'SENDING' && !emailClaimIsStale(row)) continue
    if (row.emailStatus !== 'SENDING' && row.emailStatus !== 'PENDING' && row.emailStatus !== 'FAILED') continue
    if (!(Number(row.emailAttempts || 0) < MAX_EMAIL_ATTEMPTS)) continue
    // A lookup outage is not an empty recipient list: leave the email
    // PENDING/FAILED for the next cron tick and continue with other events.
    // يحدث البحث قبل المطالبة عمدًا: انقطاع البحث لا يحرق محاولة ولا
    // يترك مطالبة معلّقة.
    const resolved = await resolveRecipients(client, row).catch((e: unknown) => {
      console.error('outbox email recipient lookup failed', row.id, e)
      return null
    })
    if (resolved === null) continue
    // المطالبة الذرية: انقلاب مشروط واحد فقط ينجح بين الموزّعين
    // المتزامنين؛ إعادة مطالبة القديم مشروطة بختمه المرصود نفسه.
    const deliveredIds = deliveredEmailRecipientIds(row.lastError)
    let activeClaimMarker = emailClaimMarker(new Date(), deliveredIds)
    const claim = await store.updateMany({
      where: {
        id: row.id,
        OR: [
          { emailStatus: { in: ['PENDING', 'FAILED'] } },
          { emailStatus: 'SENDING', lastError: row.lastError ?? null },
        ],
      },
      data: { emailStatus: 'SENDING', emailAttempts: { increment: 1 }, lastError: emailClaimMarker() },
    }).catch(() => ({ count: 0 }))
    if ((claim as any)?.count !== 1) continue
    const recipients = resolved.filter((r) => r.email)
    if (!recipients.length) {
      await store.update({ where: { id: row.id }, data: { emailStatus: 'SKIPPED', lastError: null } }).catch(() => {})
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
    // عدّاد المحاولات زيد عند المطالبة لا هنا — محاولة واحدة لكل إرسال.
    const finalStatus = outcomes.includes('FAILED') ? 'FAILED' : outcomes.includes('SKIPPED') ? 'SKIPPED' : 'SENT'
    if (finalStatus === 'SENT') emailsSent++
    else if (finalStatus === 'FAILED') emailsFailed++
    await store.update({
      where: { id: row.id },
      data: {
        emailStatus: finalStatus,
        lastError: lastError || null,
      },
    }).catch(() => {})
  }
  return { platformSent, emailsSent, emailsFailed }
}
