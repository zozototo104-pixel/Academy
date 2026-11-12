import { addDays, getSemesterUnitWindows } from './program-duration'

export type AssignmentWindow = {
  opensAt: Date
  dueAt: Date | null
  mode: 'UNIT' | 'UNIT_DAYS' | 'ENROLLMENT_DAYS' | 'LEGACY_FIXED' | 'NONE'
}

// The same academic calendar as the unit/exam gates. A linked assignment
// becomes available with its teaching unit, never on the student's first day.
// An optional shorter day limit begins on the UNIT start and cannot outlive it.
// Legacy non-unit fixed deadlines remain unchanged until explicitly converted.
export function assignmentWindow(args: {
  enrolledAt: Date
  extensionDays?: number | null
  semester: number
  unitId?: string | null
  dueDays?: number | null
  dueAtFixed?: Date | string | null
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }
  units: { id: string; semester: number; order: number }[]
}): AssignmentWindow {
  const enrolledAt = new Date(args.enrolledAt)
  const unit = args.unitId ? args.units.find((u) => u.id === args.unitId && u.semester === args.semester) : null
  const w = unit ? getSemesterUnitWindows(enrolledAt, args.program, args.units, args.extensionDays || 0)
    .find((window) => window.unitId === unit.id) : null
  if (w) {
    // An old fixed-date assignment may contain stale dueDays that were
    // historically ignored. Do not activate those days silently: use the
    // full unit window until the administrator edits the duration (which
    // clears the legacy date).
    const effectiveDays = args.dueAtFixed ? null : args.dueDays
    const shorterDue = effectiveDays != null && effectiveDays > 0 ? addDays(w.startAt, effectiveDays) : w.endAt
    return {
      opensAt: w.startAt,
      dueAt: new Date(Math.min(shorterDue.getTime(), w.endAt.getTime())),
      mode: effectiveDays != null && effectiveDays > 0 ? 'UNIT_DAYS' : 'UNIT',
    }
  }
  // An admin may select a unit as a source reference for a semester-3
  // project; a unit from a different semester must not set its deadline.
  if (args.dueAtFixed) {
    // Historical unlinked assignments may carry BOTH fields; the fixed
    // deadline won before this feature and must keep winning until edited.
    return { opensAt: enrolledAt, dueAt: new Date(args.dueAtFixed), mode: 'LEGACY_FIXED' }
  }
  if (args.dueDays != null && args.dueDays > 0) {
    return { opensAt: enrolledAt, dueAt: addDays(enrolledAt, args.dueDays), mode: 'ENROLLMENT_DAYS' }
  }
  return { opensAt: enrolledAt, dueAt: null, mode: 'NONE' }
}

// Historical two-argument callers retain this compatibility function.
export function assignmentDueAt(
  enrolledAt: Date,
  dueDays?: number | null,
  dueAtFixed?: Date | string | null,
): Date | null {
  if (dueAtFixed) return new Date(dueAtFixed)
  if (!dueDays) return null
  const d = new Date(enrolledAt)
  d.setDate(d.getDate() + dueDays)
  return d
}
