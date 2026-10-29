import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// نطاق المشرف البشري — مصدر الحقيقة الواحد لكل صلاحيات المشرف الجديدة.
// النطاق مشتق دائمًا من التعيينات الفعلية (طلبات الالتحاق التي عيّنته
// الإدارة عليها + سلاسل المحاضرات التي يملكها)، لا من أي ادعاء يرسله
// العميل. الأدمن غير مقيد (يرى الكل) تماشيًا مع بوابة المشرف القائمة.

export type SupervisorActor = { id: string; name: string; role: string }

export async function requireSupervisor(): Promise<SupervisorActor> {
  const user = await requireUser()
  if (user.role !== 'SUPERVISOR' && user.role !== 'ADMIN') throw new Error('UNAUTHORIZED')
  return { id: user.id, name: user.name, role: user.role }
}

export function isSupervisorAdmin(actor: SupervisorActor): boolean {
  return actor.role === 'ADMIN'
}

// طلاب المشرف: كل من له طلب التحاق معيّن عليه هذا المشرف وله حساب.
export async function supervisorStudentIds(actor: SupervisorActor): Promise<string[]> {
  if (isSupervisorAdmin(actor)) {
    const rows = await db.admissionApplication.findMany({ where: { userId: { not: null } }, select: { userId: true }, distinct: ['userId'] })
    return rows.map((r) => r.userId).filter((id): id is string => Boolean(id))
  }
  const rows = await db.admissionApplication.findMany({
    where: { supervisorId: actor.id, userId: { not: null } },
    select: { userId: true },
    distinct: ['userId'],
  })
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id))
}

// برامج المشرف: برامج طلابه المعيّنين عليه + برامج سلاسل محاضراته.
export async function supervisorProgramIds(actor: SupervisorActor): Promise<string[]> {
  if (isSupervisorAdmin(actor)) {
    const rows = await db.program.findMany({ select: { id: true } })
    return rows.map((r) => r.id)
  }
  const [apps, series] = await Promise.all([
    db.admissionApplication.findMany({ where: { supervisorId: actor.id, programId: { not: null } }, select: { programId: true }, distinct: ['programId'] }),
    db.lectureSeries.findMany({ where: { supervisorId: actor.id }, select: { programId: true }, distinct: ['programId'] }),
  ])
  const ids = new Set<string>()
  for (const r of apps) if (r.programId) ids.add(r.programId)
  for (const r of series) if (r.programId) ids.add(r.programId)
  return [...ids]
}

export async function canAccessProgram(actor: SupervisorActor, programId: string): Promise<boolean> {
  if (!programId) return false
  if (isSupervisorAdmin(actor)) return true
  const ids = await supervisorProgramIds(actor)
  return ids.includes(programId)
}

// هل هذا الطالب معيّن على هذا المشرف؟ (طلب التحاق واحد على الأقل)
export async function isAssignedStudent(actor: SupervisorActor, studentUserId: string): Promise<boolean> {
  if (!studentUserId) return false
  if (isSupervisorAdmin(actor)) return true
  const found = await db.admissionApplication.findFirst({
    where: { supervisorId: actor.id, userId: studentUserId },
    select: { id: true },
  })
  return Boolean(found)
}

// المشرف البشري المعيّن لطالب معيّن (أحدث طلب التحاق له مشرف) — أو null.
export async function assignedSupervisorForStudent(studentUserId: string): Promise<{ supervisorId: string; supervisionMode: string | null } | null> {
  const app = await db.admissionApplication.findFirst({
    where: { userId: studentUserId, supervisorId: { not: null } },
    orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
    select: { supervisorId: true, supervisionMode: true },
  })
  if (!app?.supervisorId) return null
  return { supervisorId: app.supervisorId, supervisionMode: app.supervisionMode ?? null }
}

// التماس مراجعة التصحيح متاح فقط لمن له مشرف بشري فعلي (مستخدم دوره
// SUPERVISOR أو ADMIN معيّن عليه) — الذكاء لا يراجع تصحيح نفسه.
export async function studentHasHumanSupervisor(studentUserId: string): Promise<boolean> {
  const assigned = await assignedSupervisorForStudent(studentUserId)
  if (!assigned) return false
  const supervisor = await db.user.findUnique({ where: { id: assigned.supervisorId }, select: { role: true, status: true } })
  return Boolean(supervisor && (supervisor.role === 'SUPERVISOR' || supervisor.role === 'ADMIN'))
}
