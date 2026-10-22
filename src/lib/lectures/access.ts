import { db } from '@/lib/db'
import { isLecturesEnabledForProgram } from './config'

// Server-side access rules for student lecture endpoints. Every check runs
// against the database on each request; hiding UI controls is never enough.

// Program ids the student is actively enrolled in AND where the lectures
// feature is enabled (global flag + pilot scope).
export async function getActiveLectureProgramIds(userId: string): Promise<string[]> {
  const enrollments = await db.enrollment.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { programId: true },
  })
  return enrollments
    .map((e: { programId: string }) => e.programId)
    .filter((id: string) => isLecturesEnabledForProgram(id))
}

export async function canStudentAccessProgram(userId: string, programId: string): Promise<boolean> {
  if (!isLecturesEnabledForProgram(programId)) return false
  const enrollment = await db.enrollment.findFirst({
    where: { userId, programId, status: 'ACTIVE' },
    select: { id: true },
  })
  return Boolean(enrollment)
}

// Shared include for session queries: only the series fields the public
// projection needs. Meeting credentials stay on the session row itself and
// are selected explicitly by the join endpoint only.
export const LECTURE_SESSION_INCLUDE = {
  series: {
    select: {
      programId: true,
      unitId: true,
      timezone: true,
      supervisor: { select: { name: true } },
      program: { select: { titleAr: true } },
    },
  },
} as const
