import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { sendEmail } from '@/lib/mailer'
import { isLecturesEnabledForProgram } from './config'
import { safeAuditDetails } from './audit'

// Authenticated actor allowed to manage lectures at all; per-series and
// per-program scope is checked separately on every action.
export async function requireLectureManager(): Promise<LectureActor> {
  const user = await requireUser()
  if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') throw new Error('UNAUTHORIZED')
  return user
}

// Server-side management rules for lectures. Authority comes from the
// existing roles (ADMIN manages everything) plus series ownership: a
// SUPERVISOR manages only series where he is the assigned supervisor, and
// only programs where he supervises at least one series. There is no
// supervisor-to-program relation in the schema, so series ownership is
// the scope — never trust a client-supplied program claim.

export type LectureActor = { id: string; name: string; role: string }

export function isAdmin(actor: LectureActor): boolean {
  return actor.role === 'ADMIN'
}

export function canManageSeries(actor: LectureActor, series: { supervisorId: string }): boolean {
  return isAdmin(actor) || series.supervisorId === actor.id
}

// المحاضر الفعلي للقاء: محاضره الخاص إن عُيّن، وإلا مشرف السلسلة.
export function effectiveLecturerId(
  session: { lecturerId?: string | null },
  series: { supervisorId: string },
): string {
  return session.lecturerId || series.supervisorId
}

// إدارة لقاء بعينه تتبع محاضره الفعلي لا مالك السلسلة وحده: لقاء عُيّن له
// محاضر خاص يظهر عند محاضره فقط ويديره هو فقط.
export function canManageSession(
  actor: LectureActor,
  session: { lecturerId?: string | null },
  series: { supervisorId: string },
): boolean {
  return isAdmin(actor) || effectiveLecturerId(session, series) === actor.id
}

export async function canManageProgram(actor: LectureActor, programId: string): Promise<boolean> {
  if (isAdmin(actor)) return true
  const owned = await db.lectureSeries.findFirst({
    where: { programId, supervisorId: actor.id },
    select: { id: true },
  })
  return Boolean(owned)
}

export async function getProgramStudentIds(programId: string): Promise<string[]> {
  const enrollments = (await db.enrollment.findMany({
    where: { programId, status: 'ACTIVE' },
    select: { userId: true },
  })) as { userId: string }[]
  const seen = new Set<string>()
  for (const e of enrollments) seen.add(e.userId)
  return [...seen]
}

// One in-app notification (and one email when a subject is given) per
// actively enrolled student. Delivery failures never fail the management
// action itself; both channels are best-effort by design of their helpers.
export async function notifyProgramStudents(
  programId: string,
  input: { type: string; title: string; body: string; link?: string; emailSubject?: string },
): Promise<number> {
  const studentIds = await getProgramStudentIds(programId)
  await Promise.all(studentIds.map((id) => notify(id, input.type, input.title, input.body, input.link)))
  if (input.emailSubject && studentIds.length) {
    const users = await db.user.findMany({
      where: { id: { in: studentIds } },
      select: { email: true },
    })
    await Promise.all(
      users.map((u: { email: string }) =>
        sendEmail({
          to: u.email,
          subject: input.emailSubject as string,
          event: input.type,
          html: `<p>${input.body}</p>`,
          text: input.body,
        }).catch(() => false),
      ),
    )
  }
  return studentIds.length
}

export async function auditLecture(
  actor: LectureActor,
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown>,
) {
  return audit(actor, action, entity, entityId, safeAuditDetails(details))
}

export function programLecturesEnabled(programId: string): boolean {
  return isLecturesEnabledForProgram(programId)
}
