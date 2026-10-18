export const OPEN_ENROLLMENT_STATUSES = ['ACTIVE', 'SUPERVISOR_ASSIGNED', 'THESIS', 'COMPLETED', 'CERTIFIED'] as const
export const REGISTERED_ONLY_STATUS = 'REGISTERED_ONLY'

export function buildAdminStudentsEnrollmentRelationFilter(status?: string | null, programId?: string | null) {
  const normalizedStatus = String(status || '').trim()
  const normalizedProgramId = String(programId || '').trim()
  const scoped: Record<string, unknown> = {}
  if (normalizedProgramId && normalizedProgramId !== 'ALL') scoped.programId = normalizedProgramId

  if (normalizedStatus === REGISTERED_ONLY_STATUS) {
    return { none: { status: { in: [...OPEN_ENROLLMENT_STATUSES] } } }
  }

  if (normalizedStatus && normalizedStatus !== 'ALL' && normalizedStatus !== 'INCOMPLETE_ADMISSIONS') {
    return { some: { ...scoped, status: normalizedStatus } }
  }

  return { some: { ...scoped, status: { in: [...OPEN_ENROLLMENT_STATUSES] } } }
}
