// المدة القصوى لدراسة البرنامج — لكل برنامج لحاله.
// القيمة الخاصة بالبرنامج تُقدَّم؛ إذا لم تُحدَّد، يُستخدم الافتراضي حسب النوع:
// دبلوم 90 يوم، ماجستير/دكتوراه 180 يوم. باقي الأنواع بلا مدة قصوى تلقائية.

export const PROGRAM_MAX_DAYS_BY_CATEGORY: Record<string, number> = {
  DIPLOMA: 90,
  MASTERS: 180,
  DOCTORATE: 180,
}

export function getProgramMaxDays(program: { category?: string | null; maxStudyDays?: number | null }): number | null {
  if (typeof program.maxStudyDays === 'number' && Number.isFinite(program.maxStudyDays) && program.maxStudyDays > 0) {
    return Math.floor(program.maxStudyDays)
  }
  const fallback = program.category ? PROGRAM_MAX_DAYS_BY_CATEGORY[program.category] : undefined
  return fallback ?? null
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function getEnrollmentDeadline(
  enrollmentCreatedAt: Date,
  program: { category?: string | null; maxStudyDays?: number | null },
  extensionDays = 0,
): Date | null {
  const maxDays = getProgramMaxDays(program)
  if (maxDays == null) return null
  return addDays(new Date(enrollmentCreatedAt), maxDays + Math.max(0, extensionDays || 0))
}

export function daysLeftUntil(deadline: Date, now = new Date()): number {
  return Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000)
}

export interface UnitWindow {
  unitId: string
  semester: number
  startAt: Date
  endAt: Date
}

// تقسيم المدة: أولًا بالتساوي على الفصول، ثم بالتساوي على وحدات كل فصل.
// الباقي (من القسمة غير الصحيحة) يذهب للفصل الأخير وآخر وحدة فيه، حتى تنتهي
// آخر وحدة تمامًا مع انتهاء المدة القصوى — لا يوم زائد ولا يوم ناقص.
export function getSemesterUnitWindows(
  enrollmentCreatedAt: Date,
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null },
  units: { id: string; semester: number; order: number }[],
  extensionDays = 0,
): UnitWindow[] {
  const maxDays = getProgramMaxDays(program)
  if (maxDays == null || !units.length) return []
  const sorted = [...units].sort((a, b) => a.semester - b.semester || a.order - b.order)
  const presentSemesters = [...new Set(sorted.map((u) => u.semester))].sort((a, b) => a - b)
  const maxSemester = presentSemesters.length ? Math.max(...presentSemesters) : 1
  const semesterCount = Math.max(maxSemester, program.semestersCount || 0, 1)
  const totalDays = maxDays + Math.max(0, extensionDays || 0)
  const baseSemesterDays = Math.floor(totalDays / semesterCount)
  const windows: UnitWindow[] = []
  let offset = 0
  for (let semester = 1; semester <= semesterCount; semester++) {
    const isLastSemester = semester === semesterCount
    const semesterDays = isLastSemester ? totalDays - offset : baseSemesterDays
    if (semesterDays <= 0) continue
    const semesterUnits = sorted.filter((u) => u.semester === semester)
    if (!semesterUnits.length) {
      offset += semesterDays
      continue
    }
    const baseUnitDays = Math.floor(semesterDays / semesterUnits.length)
    semesterUnits.forEach((unit, unitIdx) => {
      const isLastUnit = unitIdx === semesterUnits.length - 1
      const unitDays = isLastUnit ? semesterDays - baseUnitDays * (semesterUnits.length - 1) : baseUnitDays
      const startAt = addDays(new Date(enrollmentCreatedAt), offset)
      const endAt = addDays(new Date(enrollmentCreatedAt), offset + Math.max(1, unitDays))
      windows.push({ unitId: unit.id, semester, startAt, endAt })
      offset += Math.max(1, unitDays)
    })
  }
  return windows
}
