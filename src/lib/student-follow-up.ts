import { db } from '@/lib/db'
import { notify } from '@/lib/notify'
import { sendEmail, emailTemplate } from '@/lib/mailer'
import { officialWhatsAppConfigured, sendOfficialWhatsAppHumanFollowup, sendOfficialWhatsAppText } from '@/lib/whatsapp-cloud'
import { hashWhatsAppId, recordWhatsAppOutboundMessage } from '@/lib/whatsapp-conversations'

// نطاق التسجيلات المشمولة — نفس نطاق محرك التذكير اليومي (مرحلة الدراسة
// فقط: ACTIVE و SUPERVISOR_ASSIGNED)؛ يُبقى متزامنًا مع REMINDER_ENROLLMENT_STATUSES.
export const FOLLOW_UP_ENROLLMENT_STATUSES = ['ACTIVE', 'SUPERVISOR_ASSIGNED'] as const

// خدمة المتابعة — محرك الغياب: طالب ببرنامج فعّال بلا أي نشاط موثّق 3 أيام
// متتالية تصله رسالة متابعة واحدة يوميًا، وبعد 3 رسائل يتوقف الإرسال ويصبح
// وضعه «يحتاج تدخل». أي نشاط جديد يصفّر العداد.
// القنوات: منصة + إيميل + واتساب — واتساب مشمول بقرار هاريس الخاص بهذه
// الخدمة؛ قرار محرك التذكير اليومي (منصة + إيميل فقط) يبقى كما هو هناك.
// واتساب خارج نافذة 24 ساعة لا يقبل نصًا حرًا، فيُرسل قالب المتابعة المعتمد
// human_followup_ar — نفس فرع زر التحقق تمامًا.

export const FOLLOW_UP_ABSENCE_DAYS = 3
export const FOLLOW_UP_MAX_MESSAGES = 3

const DAY_MS = 24 * 60 * 60 * 1000
const WHATSAPP_WINDOW_MS = DAY_MS

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
}

export interface FollowUpStatus {
  daysAbsent: number
  followUpCount: number
  needsIntervention: boolean
  lastActivityAt: Date | null
}

// الحالة مشتقة دائمًا من (آخر نشاط + العداد) — لا علم مخزن منفصل لحالة
// «يحتاج تدخل» حتى لا يتعارض مع الواقع: رجوع الطالب يلغيها تلقائيًا.
// baselineAt (تاريخ إنشاء التسجيل) هو نقطة البدء حين لا يوجد ختم نشاط بعد،
// فلا يُحاسب طالب جديد أو قديم على أيام سبقت وجود الختم.
export function computeFollowUpStatus(
  input: { lastActivityAt: Date | null; baselineAt: Date; followUpCount: number },
  now = new Date(),
): FollowUpStatus {
  const last = input.lastActivityAt ?? input.baselineAt
  const daysAbsent = Math.max(0, Math.floor((now.getTime() - new Date(last).getTime()) / DAY_MS))
  return {
    daysAbsent,
    followUpCount: input.followUpCount,
    needsIntervention: daysAbsent >= FOLLOW_UP_ABSENCE_DAYS && input.followUpCount >= FOLLOW_UP_MAX_MESSAGES,
    lastActivityAt: input.lastActivityAt,
  }
}

export function followUpText(userName: string, programTitle: string, daysAbsent: number): { title: string; body: string } {
  const title = `متابعة دراسية: لم نرك في المنصة منذ ${daysAbsent} أيام`
  const body = [
    `مرحبًا ${userName}، لاحظنا أنك لم تدخل منصة الأكاديمية منذ ${daysAbsent} أيام، ودراستك في «${programTitle}» بانتظارك.`,
    'دقائق قليلة كل يوم تبقيك على المسار وتمنع تراكم الوحدات والواجبات عليك.',
    'ادخل لوحتك الآن وأكمل من حيث توقفت، ومشرفك جاهز لمساعدتك في أي نقطة تعلق فيها.',
  ].join('\n')
  return { title, body }
}

async function sendFollowUpEmail(to: string, name: string, title: string, body: string): Promise<boolean> {
  try {
    const paragraphs = body.split('\n').map((line) => `<p>${line.replace(/[<>]/g, '')}</p>`).join('')
    await sendEmail({
      to,
      event: 'STUDENT_FOLLOW_UP',
      subject: title,
      html: emailTemplate(title, `<p>مرحبًا ${name}،</p>${paragraphs}`, { label: 'فتح لوحة الطالب', url: 'https://aactacademy.com/?view=dashboard' }),
    })
    return true
  } catch (e) {
    console.error('follow-up email error', e)
    return false
  }
}

type WhatsAppOutcome = 'TEXT' | 'TEMPLATE' | 'FAILED' | 'SKIPPED'

async function sendFollowUpWhatsApp(user: { name: string; phone: string | null }, body: string, now: Date): Promise<WhatsAppOutcome> {
  try {
    const digits = String(user.phone || '').replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) return 'SKIPPED'
    if (!officialWhatsAppConfigured()) return 'SKIPPED'
    const conversation = await db.whatsAppConversation.findUnique({
      where: { waIdHash: hashWhatsAppId(digits) },
      select: { lastInboundAt: true },
    })
    const lastInboundAt = conversation?.lastInboundAt?.getTime() || 0
    const windowOpen = Boolean(lastInboundAt && now.getTime() - lastInboundAt >= 0 && now.getTime() - lastInboundAt < WHATSAPP_WINDOW_MS)
    if (windowOpen) {
      const result = await sendOfficialWhatsAppText(digits, body)
      await recordWhatsAppOutboundMessage({
        waId: digits,
        phoneNumberId: null,
        text: body,
        sender: 'SYSTEM',
        whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
        sentById: null,
        sentByName: 'خدمة المتابعة',
      })
      return 'TEXT'
    }
    const result = await sendOfficialWhatsAppHumanFollowup(digits, user.name)
    await recordWhatsAppOutboundMessage({
      waId: digits,
      phoneNumberId: null,
      text: `تم إرسال قالب المتابعة المعتمد human_followup_ar إلى ${user.name} (متابعة غياب). نص المتابعة الكامل يُرسل بعد أن يرد الطالب.`,
      sender: 'SYSTEM',
      whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
      sentById: null,
      sentByName: 'خدمة المتابعة',
    })
    return 'TEMPLATE'
  } catch (e) {
    console.error('follow-up whatsapp error', e)
    return 'FAILED'
  }
}

export async function processInactivityFollowUps(now = new Date()): Promise<{ checked: number; sent: number; needsIntervention: number; returned: number }> {
  const enrollments = await db.enrollment.findMany({
    where: { status: { in: [...FOLLOW_UP_ENROLLMENT_STATUSES] } },
    include: {
      program: { select: { id: true, titleAr: true } },
      user: { select: { id: true, name: true, email: true, phone: true, lastActivityAt: true } },
    },
  })
  let sent = 0
  let needsIntervention = 0
  let returned = 0
  for (const enrollment of enrollments) {
    const user = (enrollment as any).user as { id: string; name: string; email: string; phone: string | null; lastActivityAt: Date | null } | null
    if (!user) continue
    const followUpCount = Number((enrollment as any).followUpCount || 0)
    const status = computeFollowUpStatus(
      { lastActivityAt: user.lastActivityAt ?? null, baselineAt: enrollment.createdAt, followUpCount },
      now,
    )
    if (status.daysAbsent < FOLLOW_UP_ABSENCE_DAYS) {
      if (followUpCount > 0) {
        await db.enrollment.update({ where: { id: enrollment.id }, data: { followUpCount: 0, lastFollowUpAt: null } as any })
        await (db as any).studentFollowUpLog.create({
          data: { userId: user.id, enrollmentId: enrollment.id, kind: 'RETURNED', messageIndex: 0, daysAbsent: status.daysAbsent },
        }).catch(() => {})
        returned++
      }
      continue
    }
    if (status.needsIntervention) {
      needsIntervention++
      continue
    }
    const lastFollowUpAt = (enrollment as any).lastFollowUpAt as Date | null
    if (lastFollowUpAt && sameDay(new Date(lastFollowUpAt), now)) continue
    const messageIndex = followUpCount + 1
    const { title, body } = followUpText(user.name || 'الطالب', (enrollment as any).program?.titleAr || '', status.daysAbsent)
    await notify(user.id, 'FOLLOW_UP', title, body, '/?view=dashboard')
    const emailSent = user.email ? await sendFollowUpEmail(user.email, user.name || 'الطالب', title, body) : false
    const whatsappStatus = await sendFollowUpWhatsApp({ name: user.name || 'الطالب', phone: user.phone }, body, now)
    await (db as any).studentFollowUpLog.create({
      data: {
        userId: user.id,
        enrollmentId: enrollment.id,
        kind: 'INACTIVITY_MESSAGE',
        messageIndex,
        daysAbsent: status.daysAbsent,
        platformSent: true,
        emailSent,
        whatsappStatus,
        title,
        body,
      },
    }).catch(() => {})
    await db.enrollment.update({ where: { id: enrollment.id }, data: { followUpCount: messageIndex, lastFollowUpAt: now } as any })
    sent++
  }
  return { checked: enrollments.length, sent, needsIntervention, returned }
}
