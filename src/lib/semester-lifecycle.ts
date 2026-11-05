import { db } from './db'
import { addDays, getProgramMaxDays, getSemesterUnitWindows, type UnitWindow } from './program-duration'

// دورة حياة الفصل (المرحلة 4): حالة محفوظة لكل (التحاق × فصل). النوافذ
// مشتقة من نفس تقسيم المدة القائم في program-duration (المدة الكلية
// بالتساوي على الفصول، ثم بالتساوي على الوحدات، والباقي للأخير) — لا
// نظام مواعيد موازٍ. الإغلاق حالة خادمية تُختم عند اعتماد النتيجة.
type AnyClient = any

export type SemesterWindow = { semester: number; startAt: Date; endAt: Date }

export function getSemesterWindows(
  enrollmentCreatedAt: Date,
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null },
  units: { id: string; semester: number; order: number }[],
  extensionDays = 0,
): SemesterWindow[] {
  const maxDays = getProgramMaxDays(program)
  if (maxDays == null) return []
  const maxUnitSemester = units.length ? Math.max(...units.map((u) => u.semester)) : 1
  const semesterCount = Math.max(maxUnitSemester, program.semestersCount || 0, 1)
  const totalDays = maxDays + Math.max(0, extensionDays || 0)
  const base = Math.floor(totalDays / semesterCount)
  const windows: SemesterWindow[] = []
  let offset = 0
  for (let semester = 1; semester <= semesterCount; semester++) {
    const isLast = semester === semesterCount
    const days = isLast ? totalDays - offset : base
    if (days > 0) {
      windows.push({
        semester,
        startAt: addDays(new Date(enrollmentCreatedAt), offset),
        endAt: addDays(new Date(enrollmentCreatedAt), offset + days),
      })
    }
    offset += days
  }
  return windows
}

export function unitWindowFor(
  enrollmentCreatedAt: Date,
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null },
  units: { id: string; semester: number; order: number }[],
  unitId: string,
  extensionDays = 0,
): UnitWindow | null {
  return getSemesterUnitWindows(enrollmentCreatedAt, program, units, extensionDays).find((w) => w.unitId === unitId) ?? null
}

type EnrollmentLike = { id: string; createdAt: Date | string; extensionDays?: number | null }
type ProgramLike = { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }

async function loadUnits(client: AnyClient, programId: string) {
  return client.unit.findMany({
    where: { programId },
    select: { id: true, semester: true, order: true },
  }).catch(() => [])
}

// إنشاء حالات الفصول المفتوحة بنوافذها إن غابت — لا يمسّ حالة قائمة
// أبدًا (وبالأخص لا يعيد فتح فصل مغلق).
export async function ensureSemesterStates(client: AnyClient, enrollment: EnrollmentLike & { programId: string }, program: ProgramLike) {
  const store = (client as AnyClient)?.enrollmentSemesterState
  if (!store?.findUnique || !store?.create) return []
  const units = await loadUnits(client, enrollment.programId)
  const windows = getSemesterWindows(new Date(enrollment.createdAt), program, units, enrollment.extensionDays || 0)
  const states: any[] = []
  for (const [i, w] of windows.entries()) {
    const existing = await store.findUnique({
      where: { enrollmentId_semester: { enrollmentId: enrollment.id, semester: w.semester } },
    }).catch(() => null)
    if (existing) {
      states.push(existing)
      continue
    }
    const created = await store.create({
      data: {
        enrollmentId: enrollment.id,
        semester: w.semester,
        status: 'OPEN',
        openedAt: w.startAt,
        submissionDeadline: w.endAt,
        nextSemesterStartsAt: windows[i + 1]?.startAt ?? null,
      },
    }).catch(() => null)
    if (created) states.push(created)
  }
  return states
}

export async function getSemesterState(client: AnyClient, enrollmentId: string, semester: number) {
  const store = (client as AnyClient)?.enrollmentSemesterState
  if (!store?.findUnique) return null
  return store.findUnique({
    where: { enrollmentId_semester: { enrollmentId, semester } },
  }).catch(() => null)
}

// ختم الإغلاق داخل معاملة الاعتماد نفسها: الحالة والنتيجة والدرجة
// المعتمدة تُحفظ ذرّيًا مع سجل الاعتماد وأحداث الصادر.
export async function closeSemesterState(
  client: AnyClient,
  args: { enrollmentId: string; semester: number; score: number; passed: boolean },
) {
  const store = (client as AnyClient)?.enrollmentSemesterState
  if (!store?.update) return null
  return store.update({
    where: { enrollmentId_semester: { enrollmentId: args.enrollmentId, semester: args.semester } },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      result: args.passed ? 'PASSED' : 'FAILED',
      approvedScore: args.score,
    },
  }).catch(() => null)
}
