import { db } from '@/lib/db'
import { notify, audit } from '@/lib/notify'
import { sendEmail, emailTemplate } from '@/lib/mailer'
import { calculateFinalGrade } from '@/lib/final-grade'
import {
  getProgramMaxDays,
  getEnrollmentDeadline,
  getSemesterUnitWindows,
  daysLeftUntil,
  addDays,
} from '@/lib/program-duration'

// محرك التذكير اليومي + إغلاق البرنامج عند انتهاء المدة القصوى.
// القنوات: منصة + إيميل فقط، أبدًا واتساب (قرار هاريس).
// مرحلة الدراسة فقط: ACTIVE و SUPERVISOR_ASSIGNED. مرحلة البحث (THESIS) لها
// مهلتها الخاصة (3-6 أشهر) ولا يُغلقها هذا المحرك، والمكتمل/المصدَّق لا يُمسّ.

export const REMINDER_ENROLLMENT_STATUSES = ['ACTIVE', 'SUPERVISOR_ASSIGNED'] as const

function safeJsonArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
}

function fmtDate(d: Date): string {
  try {
    return d.toLocaleDateString('ar-EG')
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

export interface PendingItem {
  kind: 'UNIT' | 'ASSIGNMENT' | 'UNIT_EXAM'
  title: string
  detail: string
  link: string
}

export interface EnrollmentReminder {
  enrollmentId: string
  programId: string
  programTitle: string
  maxDays: number | null
  deadlineAt: Date | null
  daysLeft: number | null
  unitWindows: { unitId: string; semester: number; startAt: Date; endAt: Date; title: string }[]
  pending: PendingItem[]
}

export async function buildEnrollmentReminder(enrollment: any, now = new Date()): Promise<EnrollmentReminder> {
  const program = enrollment.program
  const maxDays = getProgramMaxDays(program)
  const deadlineAt = getEnrollmentDeadline(enrollment.createdAt, program, enrollment.extensionDays || 0)
  const daysLeft = deadlineAt ? daysLeftUntil(deadlineAt, now) : null
  const completedUnits = safeJsonArray(enrollment.completedUnits)
  const units = await db.unit.findMany({
    where: { programId: enrollment.programId, status: 'APPROVED' },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: { id: true, title: true, semester: true, order: true },
  })
  const windows = getSemesterUnitWindows(enrollment.createdAt, program, units, enrollment.extensionDays || 0)
  const windowByUnit = new Map(windows.map((w) => [w.unitId, w]))
  const unitWindows = windows.map((w) => ({
    ...w,
    title: units.find((u) => u.id === w.unitId)?.title || '',
  }))
  const pending: PendingItem[] = []
  for (const unit of units) {
    if (completedUnits.includes(unit.id)) continue
    const w = windowByUnit.get(unit.id)
    const detail = w
      ? daysLeftUntil(w.endAt, now) < 0
        ? `انتهت نافذتها في ${fmtDate(w.endAt)} — أكملها الآن`
        : `نافذتها حتى ${fmtDate(w.endAt)}`
      : 'بانتظار الإكمال'
    pending.push({ kind: 'UNIT', title: unit.title, detail, link: '/?view=dashboard' })
  }
  const assignments = await db.programAssignment.findMany({
    where: { programId: enrollment.programId, status: 'PUBLISHED' },
    select: { id: true, title: true, dueDays: true },
  })
  const submissions = await db.assignmentSubmission.findMany({
    where: { userId: enrollment.userId, assignmentId: { in: assignments.map((a) => a.id) } },
    select: { assignmentId: true, status: true },
  })
  const submittedIds = new Set(submissions.filter((s) => s.status === 'SUBMITTED' || s.status === 'GRADED').map((s) => s.assignmentId))
  for (const a of assignments) {
    if (submittedIds.has(a.id)) continue
    const dueAt = a.dueDays ? addDays(new Date(enrollment.createdAt), a.dueDays) : null
    const detail = dueAt
      ? daysLeftUntil(dueAt, now) < 0
        ? `انتهى موعده في ${fmtDate(dueAt)} — سلّمه الآن`
        : `آخر موعد ${fmtDate(dueAt)}`
      : 'بانتظار التسليم'
    pending.push({ kind: 'ASSIGNMENT', title: a.title, detail, link: '/?view=dashboard' })
  }
  const exams = await db.exam.findMany({
    where: { unit: { programId: enrollment.programId }, status: 'READY', questions: { some: {} } },
    select: { id: true, title: true, unitId: true, unit: { select: { title: true } } },
  })
  const passedAttempts = await db.examAttempt.findMany({
    where: { userId: enrollment.userId, examId: { in: exams.map((e) => e.id) }, passed: true },
    select: { examId: true },
  })
  const passedIds = new Set(passedAttempts.map((a) => a.examId))
  for (const exam of exams) {
    if (passedIds.has(exam.id)) continue
    if (completedUnits.includes(exam.unitId)) continue
    pending.push({ kind: 'UNIT_EXAM', title: exam.unit?.title || exam.title, detail: 'أسئلة الوحدة بانتظار الحل', link: '/?view=dashboard' })
  }
  return { enrollmentId: enrollment.id, programId: enrollment.programId, programTitle: program.titleAr, maxDays, deadlineAt, daysLeft, unitWindows, pending }
}

export function reminderText(reminder: EnrollmentReminder, userName: string): { title: string; body: string } {
  const lines: string[] = []
  if (reminder.deadlineAt && reminder.daysLeft != null && reminder.daysLeft <= 10 && reminder.daysLeft > 0) {
    lines.push(`تنبيه مهم: باقي ${reminder.daysLeft} أيام على انتهاء مدة برنامج «${reminder.programTitle}» (${fmtDate(reminder.deadlineAt)})، وبعدها يُغلق البرنامج وتُرصَّد درجتك. إذا احتجت وقتًا إضافيًا، اطلب تمديدًا بأسباب مقنعة من لوحتك قبل انتهاء المدة.`)
  }
  const top = reminder.pending.slice(0, 5)
  for (const item of top) {
    const kindLabel = item.kind === 'UNIT' ? 'وحدة' : item.kind === 'ASSIGNMENT' ? 'واجب' : 'أسئلة وحدة'
    lines.push(`${kindLabel}: «${item.title}» — ${item.detail}`)
  }
  if (reminder.pending.length > 5) lines.push(`و${reminder.pending.length - 5} مهام أخرى بانتظارك.`)
  lines.push('تابع مع مشرفك الذكي من لوحتك إذا علقت في أي نقطة.')
  const title = reminder.deadlineAt && reminder.daysLeft != null && reminder.daysLeft <= 10
    ? `اقترب انتهاء برنامجك — باقي ${reminder.daysLeft} أيام`
    : `تذكير دراسي: ${reminder.pending.length} مهام بانتظارك في «${reminder.programTitle}»`
  return { title, body: lines.join('\n') }
}

async function sendReminderEmail(to: string, name: string, title: string, body: string) {
  try {
    const paragraphs = body.split('\n').map((line) => `<p>${line.replace(/[<>]/g, '')}</p>`).join('')
    await sendEmail({
      to,
      event: 'STUDENT_REMINDER',
      subject: title,
      html: emailTemplate(title, `<p>مرحبًا ${name}،</p>${paragraphs}`, { label: 'فتح لوحة الطالب', url: 'https://aactacademy.com/?view=dashboard' }),
    })
  } catch (e) {
    console.error('student reminder email error', e)
  }
}

export async function closeExpiredEnrollment(enrollment: any, now = new Date()): Promise<{ closed: boolean; finalScore: number | null }> {
  let finalScore: number | null = null
  try {
    const result = await calculateFinalGrade({ userId: enrollment.userId, programId: enrollment.programId })
    finalScore = result.score ?? null
  } catch (e) {
    console.error('close enrollment grade error', e)
  }
  await db.enrollment.update({
    where: { id: enrollment.id },
    data: { status: 'EXPIRED', ...(finalScore != null ? { finalScore } : {}) },
  })
  await audit(null, 'ENROLLMENT_EXPIRED', 'Enrollment', enrollment.id, `أُغلق البرنامج لانتهاء المدة القصوى — الدرجة المرصودة: ${finalScore ?? 'لا يوجد'}`)
  const user = await db.user.findUnique({ where: { id: enrollment.userId }, select: { name: true, email: true } })
  const program = await db.program.findUnique({ where: { id: enrollment.programId }, select: { titleAr: true } })
  const title = `أُغلق برنامج «${program?.titleAr || ''}» لانتهاء مدته`
  const body = `انتهت المدة القصوى لبرنامجك، فأُغلق البرنامج ورُصّدت درجتك الحالية${finalScore != null ? ` (${finalScore})` : ''}. إذا كان لديك سبب مقنع، يمكنك طلب تمديد من لوحتك وسيقرر الأدمن.`
  await notify(enrollment.userId, 'GENERAL', title, body, '/?view=dashboard')
  if (user?.email) await sendReminderEmail(user.email, user.name || 'الطالب', title, body)
  return { closed: true, finalScore }
}

export async function processDailyReminders(now = new Date()): Promise<{ checked: number; reminded: number; closed: number; warned: number }> {
  const enrollments = await db.enrollment.findMany({
    where: { status: { in: [...REMINDER_ENROLLMENT_STATUSES] } },
    include: { program: { select: { id: true, titleAr: true, category: true, maxStudyDays: true, semestersCount: true } }, user: { select: { id: true, name: true, email: true } } },
  })
  let reminded = 0
  let closed = 0
  let warned = 0
  for (const enrollment of enrollments) {
    const reminder = await buildEnrollmentReminder(enrollment, now)
    if (reminder.deadlineAt && reminder.daysLeft != null && reminder.daysLeft <= 0) {
      await closeExpiredEnrollment(enrollment, now)
      closed++
      continue
    }
    const needsWarning = reminder.deadlineAt && reminder.daysLeft != null && reminder.daysLeft <= 10
    if (needsWarning) warned++
    if (!reminder.pending.length && !needsWarning) continue
    if (enrollment.lastReminderAt && sameDay(new Date(enrollment.lastReminderAt), now)) continue
    const { title, body } = reminderText(reminder, enrollment.user?.name || 'الطالب')
    await notify(enrollment.userId, 'GENERAL', title, body, '/?view=dashboard')
    if (enrollment.user?.email) await sendReminderEmail(enrollment.user.email, enrollment.user.name || 'الطالب', title, body)
    await db.enrollment.update({ where: { id: enrollment.id }, data: { lastReminderAt: now } })
    reminded++
  }
  return { checked: enrollments.length, reminded, closed, warned }
}
