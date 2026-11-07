import { db } from './db'
import { isAactTestEmail } from './prod-safety'
import { emailTemplate, sendEmailDetailed } from './mailer'

// سجل الأحداث الصادرة (المرحلتان 4 و6): إشعارات دورة حياة الطالب لا
// تُرسل نداءات نارية مباشرة؛ تُحفظ كحدث داخل نفس معاملة تغيير الحالة
// بمفتاح عدم تكرار فريد، ويوزّعها الموزّع لاحقًا:
// - داخل المنصة: إنشاء الإشعارات وانقلاب الحدث إلى SENT بمعاملة واحدة
//   ⟹ عدم تكرار مضمون بمفتاح الحدث.
// - البريد: يُطالَب به ذرّيًا قبل الإرسال بحقول مطالبة مستقلة
//   (emailClaimId + emailClaimLeaseUntil — E02) فلا يرسله موزّعان
//   متزامنان، ونتيجة كل مستلم تُحفظ في سجل NotificationOutboxRecipient
//   فور قبول المزوّد لها. مستلم كان قيد الإرسال حين ماتت مطالبة عامل
//   يُقفل UNKNOWN ولا يُعاد إرساله تلقائيًا أبدًا — SMTP بلا مفتاح عدم
//   تكرار، فتلك النافذة تُوسم ولا تُدّعى مضمونة الإغلاق.
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

// E02: مطالبة البريد بحقول مستقلة (emailClaimId/emailClaimLeaseUntil)
// وسجل نتيجة لكل مستلم (NotificationOutboxRecipient). العقد 10 دقائق
// كالسابق؛ المطالبة المنتهية عقدها يتيمة — صاحبها مات قبل الحسم —
// وتُسترد بمطابقة معرّف مطالبتها المرصود (CAS).
const EMAIL_CLAIM_LEASE_MS = 10 * 60 * 1000

// قراءة انتقالية فقط (لا تُكتب أبدًا بعد E02): صفوف كانت مطالَبة
// بالترميز القديم — ختم «EMAIL_CLAIM:<ISO>» وقائمة «EMAIL_SENT_IDS:»
// داخل lastError — وقت نشر هذا الكود تُتبنّى كما هي: حداثتها تُحسب
// من ختمها، ومستلموها المُسلَّمون يُزرعون في السجل من قائمتها، ثم
// تُدار بالحقول الجديدة كبقية الصفوف.
const EMAIL_CLAIM_PREFIX = 'EMAIL_CLAIM:'
const EMAIL_SENT_IDS_PREFIX = 'EMAIL_SENT_IDS:'

function legacyDeliveredRecipientIds(lastError: unknown): Set<string> {
  const line = String(lastError || '').split('\n').find((part) => part.startsWith(EMAIL_SENT_IDS_PREFIX))
  if (!line) return new Set()
  try {
    const ids = JSON.parse(line.slice(EMAIL_SENT_IDS_PREFIX.length))
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length <= 128) : [])
  } catch { return new Set() }
}

function legacyEmailClaimIsStale(row: any, now = Date.now()) {
  const firstLine = String(row?.lastError || '').split('\n')[0]
  if (!firstLine.startsWith(EMAIL_CLAIM_PREFIX)) return true
  const claimedAt = Date.parse(firstLine.slice(EMAIL_CLAIM_PREFIX.length))
  return !Number.isFinite(claimedAt) || now - claimedAt > EMAIL_CLAIM_LEASE_MS
}

function emailClaimIsLive(row: any, now = Date.now()) {
  if (row?.emailStatus !== 'SENDING') return false
  if (row.emailClaimId) {
    return row.emailClaimLeaseUntil ? new Date(row.emailClaimLeaseUntil).getTime() > now : false
  }
  // مطالبة بالترميز القديم (بلا حقول): حداثتها من ختم lastError.
  return !legacyEmailClaimIsStale(row, now)
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
  // تُرشَّح أيضًا صفوف SENDING (مطالبات سابقة) وتُفحص حداثة عقدها.
  const ledger = (client as AnyClient)?.notificationOutboxRecipient
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
    if (emailClaimIsLive(row)) continue
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
    // مستلمو الترميز القديم المُسلَّمون فعلًا (يُقرؤون قبل المطالبة لأن
    // المطالبة تمسح lastError) — يُزرعون SENT في السجل عند التبنّي.
    const legacyDeliveredIds = row.emailClaimId ? new Set<string>() : legacyDeliveredRecipientIds(row.lastError)
    // المطالبة الذرية بحقول مستقلة: انقلاب مشروط واحد فقط ينجح بين
    // الموزّعين؛ استرداد مطالبة ميتة مشروط بمعرّفها المرصود (أو بختمها
    // القديم للصفوف السابقة لـE02).
    const claimId = `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const claimOr: any[] = [{ emailStatus: { in: ['PENDING', 'FAILED'] } }]
    if (row.emailStatus === 'SENDING' && row.emailClaimId) {
      claimOr.push({ emailStatus: 'SENDING', emailClaimId: row.emailClaimId, emailClaimLeaseUntil: { lt: new Date() } })
    } else if (row.emailStatus === 'SENDING') {
      claimOr.push({ emailStatus: 'SENDING', emailClaimId: null, lastError: row.lastError ?? null })
    }
    const claim = await store.updateMany({
      where: { id: row.id, OR: claimOr },
      data: {
        emailStatus: 'SENDING',
        emailAttempts: { increment: 1 },
        emailClaimId: claimId,
        emailClaimLeaseUntil: new Date(Date.now() + EMAIL_CLAIM_LEASE_MS),
        lastError: null,
      },
    }).catch(() => ({ count: 0 }))
    if ((claim as any)?.count !== 1) continue
    const finalizeClaim = async (finalStatus: string, finalError: string | null) => {
      const finalized = await store.updateMany({
        where: { id: row.id, emailStatus: 'SENDING', emailClaimId: claimId },
        data: { emailStatus: finalStatus, lastError: finalError, emailClaimId: null, emailClaimLeaseUntil: null },
      }).catch(() => ({ count: 0 }))
      if ((finalized as any)?.count !== 1) {
        // مطالبتنا استُردت أثناء الإرسال الطويل؛ المالك الجديد يحسم.
        console.error('outbox email finalize lost claim', row.id)
        return false
      }
      if (finalStatus === 'SENT') emailsSent++
      else if (finalStatus === 'FAILED') emailsFailed++
      return true
    }
    const recipients = resolved.filter((r) => r.email)
    if (!recipients.length) {
      await finalizeClaim('SKIPPED', null)
      continue
    }
    // تبنّي أيتام المطالبة الميتة: من كان PROCESSING حين مات عاملها
    // نتيجته مجهولة بنيويًا (قُبلت ربما ولم تُحفظ) — يُقفل UNKNOWN ولا
    // يُعاد إرساله تلقائيًا أبدًا.
    await ledger.updateMany({
      where: { outboxId: row.id, status: 'PROCESSING' },
      data: { status: 'UNKNOWN', lastError: 'CLAIM_EXPIRED_WHILE_SENDING' },
    }).catch(() => ({ count: 0 }))
    // ضمان صفوف السجل لكل مستلم حالي (موجودة تبقى بحالتها: SENT لا
    // يُرسل ثانية، وFAILED يُعاد ضمن هذه المطالبة، وUNKNOWN لا يُلمس).
    await ledger.createMany({
      data: recipients.map((r) => ({ outboxId: row.id, recipientUserId: r.id, email: r.email as string })),
      skipDuplicates: true,
    }).catch(() => {})
    if (legacyDeliveredIds.size) {
      await ledger.updateMany({
        where: { outboxId: row.id, recipientUserId: { in: [...legacyDeliveredIds] }, status: 'PENDING' },
        data: { status: 'SENT', sentAt: new Date(), lastError: 'LEGACY_CHECKPOINT' },
      }).catch(() => ({ count: 0 }))
    }
    const due = await ledger.findMany({
      where: { outboxId: row.id, status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
    }).catch(() => [])
    for (const entry of due) {
      const picked = await ledger.updateMany({
        where: { id: entry.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      }).catch(() => ({ count: 0 }))
      if ((picked as any)?.count !== 1) continue
      let sendError: string | null = null
      const status = await sendEmailDetailed({
        to: entry.email,
        subject: row.title,
        event: row.kind,
        html: emailTemplate(row.title, row.body),
      }).catch((e: any) => { sendError = String(e?.message || e); return 'FAILED' as const })
      // نقطة الحفظ بعد قبول المزوّد مباشرة وقبل المستلم التالي: نتيجة
      // هذا المستلم صارت دائمة في سجله، فموت العامل الآن لا يكرّره.
      await ledger.update({
        where: { id: entry.id },
        data: status === 'SENT'
          ? { status: 'SENT', sentAt: new Date(), lastError: null }
          : status === 'SKIPPED'
            ? { status: 'SKIPPED', lastError: null }
            : { status: 'FAILED', lastError: (sendError || 'send failed').slice(0, 1000) },
      }).catch((e: unknown) => {
        // تعذّر حفظ النتيجة: يبقى الصف PROCESSING فيُقفل UNKNOWN عند
        // استرداد المطالبة بدل أن يُعاد إرساله على عماه.
        console.error('outbox email recipient checkpoint failed', row.id, entry.id, e)
      })
    }
    // الحسم من حالة السجل النهائية لا من ذاكرة الحلقة.
    const finalRows = await ledger.findMany({ where: { outboxId: row.id } }).catch(() => [])
    if (finalRows.some((entry: any) => entry.status === 'PENDING' || entry.status === 'PROCESSING')) {
      // بقي عمل غير محسوم (صف تعذّر حفظ نتيجته): تبقى المطالبة حتى
      // ينتهي عقدها فيُسترد ويُقفل المجهول UNKNOWN — لا حسم كاذب.
      continue
    }
    const failedRow = finalRows.find((entry: any) => entry.status === 'FAILED')
    const anyDelivered = finalRows.some((entry: any) => entry.status === 'SENT' || entry.status === 'UNKNOWN')
    const finalStatus = failedRow ? 'FAILED' : anyDelivered ? 'SENT' : 'SKIPPED'
    await finalizeClaim(finalStatus, failedRow ? String(failedRow.lastError || 'send failed').slice(0, 1000) : null)
  }
  return { platformSent, emailsSent, emailsFailed }
}
