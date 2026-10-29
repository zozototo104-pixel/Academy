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

// ===== لوحة المتابعة وسجل الطالب (المرحلة 2) =====
// صف واحد لكل تسجيل فعّال: حالة الدخول والغياب + واجبات الطالب (واجبات،
// اختبارات وحدات، محاضرات، تفاعل المشرف، رسائل المنصة) — نفس الأرقام التي
// تراها الإدارة ويراها المشرف لطلابه.

export interface FollowUpBoardRow {
  userId: string
  enrollmentId: string
  admissionId: string | null
  name: string
  email: string
  programId: string
  programTitle: string
  specialization: string
  lastActivityAt: Date | null
  daysAbsent: number
  followUpCount: number
  needsIntervention: boolean
  followUpsSent: number
  platformMessages: number
  unreadPlatformMessages: number
  assignments: { total: number; submitted: number }
  unitExams: { total: number; passed: number }
  lectures: { total: number; watched: number; completed: number }
  supervisorInteraction: { count: number; lastAt: Date | null }
}

export async function listFollowUpBoard(options?: { userIds?: string[] }): Promise<FollowUpBoardRow[]> {
  const enrollments = await db.enrollment.findMany({
    where: {
      status: { in: [...FOLLOW_UP_ENROLLMENT_STATUSES] },
      ...(options?.userIds ? { userId: { in: options.userIds } } : {}),
    },
    include: {
      program: { select: { id: true, titleAr: true } },
      user: { select: { id: true, name: true, email: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  if (!enrollments.length) return []
  const userIds = [...new Set(enrollments.map((e) => e.userId))]
  const programIds = [...new Set(enrollments.map((e) => e.programId))]

  const users = await (db as any).user.findMany({ where: { id: { in: userIds } }, select: { id: true, lastActivityAt: true } })
  const lastActivityByUser = new Map<string, Date | null>(users.map((u: any) => [u.id, u.lastActivityAt ?? null]))

  const [assignmentTotals, units, lectureTotals, admissions, submissions, attempts, watchRows, notifTotals, notifUnread, followUpTotals, channelCounts, channelLatest] = await Promise.all([
    db.programAssignment.groupBy({ by: ['programId'], where: { programId: { in: programIds }, status: 'PUBLISHED' }, _count: { _all: true } }).catch(() => [] as any[]),
    db.unit.findMany({ where: { programId: { in: programIds } }, select: { id: true, programId: true, exam: { select: { id: true } } } }).catch(() => [] as any[]),
    db.lectureVideoResource.groupBy({ by: ['programId'], where: { programId: { in: programIds } }, _count: { _all: true } }).catch(() => [] as any[]),
    db.admissionApplication.findMany({ where: { userId: { in: userIds } }, orderBy: { createdAt: 'desc' }, select: { id: true, userId: true, specialization: true } }).catch(() => [] as any[]),
    db.assignmentSubmission.findMany({ where: { userId: { in: userIds } }, select: { userId: true, assignmentId: true, assignment: { select: { programId: true } } } }).catch(() => [] as any[]),
    db.examAttempt.findMany({ where: { userId: { in: userIds } }, select: { userId: true, examId: true, passed: true } }).catch(() => [] as any[]),
    (db as any).lectureWatchProgress.findMany({ where: { userId: { in: userIds } }, select: { userId: true, watchedPercent: true, completedAt: true, video: { select: { programId: true } } } }).catch(() => [] as any[]),
    db.notification.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } }).catch(() => [] as any[]),
    db.notification.groupBy({ by: ['userId'], where: { userId: { in: userIds }, read: false }, _count: { _all: true } }).catch(() => [] as any[]),
    (db as any).studentFollowUpLog.groupBy({ by: ['userId'], where: { userId: { in: userIds }, kind: 'INACTIVITY_MESSAGE' }, _count: { _all: true } }).catch(() => [] as any[]),
    db.supervisorChannelMessage.groupBy({ by: ['studentId'], where: { studentId: { in: userIds }, scope: 'SUPERVISION' }, _count: { _all: true } }).catch(() => [] as any[]),
    db.supervisorChannelMessage.findMany({ where: { studentId: { in: userIds }, scope: 'SUPERVISION' }, distinct: ['studentId'], orderBy: { createdAt: 'desc' }, select: { studentId: true, createdAt: true } }).catch(() => [] as any[]),
  ])

  const assignmentTotalByProgram = new Map(assignmentTotals.map((r: any) => [r.programId, r._count._all]))
  const lectureTotalByProgram = new Map(lectureTotals.map((r: any) => [r.programId, r._count._all]))
  const examTotalByProgram = new Map<string, number>()
  const examProgram = new Map<string, string>()
  for (const unit of units as any[]) {
    if (unit.exam?.id) {
      examTotalByProgram.set(unit.programId, (examTotalByProgram.get(unit.programId) || 0) + 1)
      examProgram.set(unit.exam.id, unit.programId)
    }
  }
  const admissionByUser = new Map<string, any>()
  for (const admission of admissions as any[]) {
    if (admission.userId && !admissionByUser.has(admission.userId)) admissionByUser.set(admission.userId, admission)
  }
  const submittedByUserProgram = new Map<string, Set<string>>()
  for (const sub of submissions as any[]) {
    const key = `${sub.userId}|${sub.assignment?.programId || ''}`
    if (!submittedByUserProgram.has(key)) submittedByUserProgram.set(key, new Set())
    submittedByUserProgram.get(key)!.add(sub.assignmentId)
  }
  const passedByUserProgram = new Map<string, Set<string>>()
  for (const attempt of attempts as any[]) {
    if (!attempt.passed) continue
    const programId = examProgram.get(attempt.examId)
    if (!programId) continue
    const key = `${attempt.userId}|${programId}`
    if (!passedByUserProgram.has(key)) passedByUserProgram.set(key, new Set())
    passedByUserProgram.get(key)!.add(attempt.examId)
  }
  const watchByUserProgram = new Map<string, { watched: number; completed: number }>()
  for (const row of watchRows as any[]) {
    const key = `${row.userId}|${row.video?.programId || ''}`
    const entry = watchByUserProgram.get(key) || { watched: 0, completed: 0 }
    if ((row.watchedPercent || 0) > 0 || row.completedAt) entry.watched++
    if (row.completedAt) entry.completed++
    watchByUserProgram.set(key, entry)
  }
  const notifTotalByUser = new Map(notifTotals.map((r: any) => [r.userId, r._count._all]))
  const notifUnreadByUser = new Map(notifUnread.map((r: any) => [r.userId, r._count._all]))
  const followUpTotalByUser = new Map(followUpTotals.map((r: any) => [r.userId, r._count._all]))
  const channelCountByUser = new Map(channelCounts.map((r: any) => [r.studentId, r._count._all]))
  const channelLastByUser = new Map((channelLatest as any[]).map((r) => [r.studentId, r.createdAt]))

  const now = new Date()
  return enrollments.map((enrollment: any) => {
    const user = enrollment.user
    const followUpCount = Number(enrollment.followUpCount || 0)
    const status = computeFollowUpStatus({ lastActivityAt: lastActivityByUser.get(enrollment.userId) ?? null, baselineAt: enrollment.createdAt, followUpCount }, now)
    const admission = admissionByUser.get(enrollment.userId)
    const watch = watchByUserProgram.get(`${enrollment.userId}|${enrollment.programId}`) || { watched: 0, completed: 0 }
    return {
      userId: enrollment.userId,
      enrollmentId: enrollment.id,
      admissionId: admission?.id || null,
      name: user?.name || 'طالب',
      email: user?.email || '',
      programId: enrollment.programId,
      programTitle: enrollment.program?.titleAr || '',
      specialization: admission?.specialization || enrollment.program?.titleAr || '',
      lastActivityAt: status.lastActivityAt,
      daysAbsent: status.daysAbsent,
      followUpCount,
      needsIntervention: status.needsIntervention,
      followUpsSent: followUpTotalByUser.get(enrollment.userId) || 0,
      platformMessages: notifTotalByUser.get(enrollment.userId) || 0,
      unreadPlatformMessages: notifUnreadByUser.get(enrollment.userId) || 0,
      assignments: { total: assignmentTotalByProgram.get(enrollment.programId) || 0, submitted: submittedByUserProgram.get(`${enrollment.userId}|${enrollment.programId}`)?.size || 0 },
      unitExams: { total: examTotalByProgram.get(enrollment.programId) || 0, passed: passedByUserProgram.get(`${enrollment.userId}|${enrollment.programId}`)?.size || 0 },
      lectures: { total: lectureTotalByProgram.get(enrollment.programId) || 0, watched: watch.watched, completed: watch.completed },
      supervisorInteraction: { count: channelCountByUser.get(enrollment.userId) || 0, lastAt: channelLastByUser.get(enrollment.userId) || null },
    }
  })
}

export async function getStudentFollowUpRecord(userId: string) {
  const [logs, notifications, adminMessages] = await Promise.all([
    (db as any).studentFollowUpLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []),
    db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, type: true, title: true, body: true, read: true, createdAt: true } }).catch(() => [] as any[]),
    db.supervisorChannelMessage.findMany({ where: { studentId: userId, scope: 'ADMIN' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } }).catch(() => [] as any[]),
  ])
  const adminCount = await db.supervisorChannelMessage.count({ where: { studentId: userId, scope: 'ADMIN' } }).catch(() => 0)
  return {
    logs,
    notifications,
    adminMessages: { count: adminCount, lastAt: (adminMessages as any[])[0]?.createdAt || null },
  }
}
