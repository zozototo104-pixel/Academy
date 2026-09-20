import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

const READINESS_STATUSES = new Set(['NEEDS_PREPARATION', 'IN_PREPARATION', 'READY_FOR_REVIEW', 'APPROVED'])
const REGISTRATION_STATUSES = new Set(['OPEN', 'CLOSED'])

function cleanText(value: unknown, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) || null
}

function safeJsonHasRules(value: any) {
  if (!value) return false
  const rules = typeof value === 'string' ? (() => { try { return JSON.parse(value) } catch { return null } })() : value
  if (!rules || typeof rules !== 'object') return false
  return Boolean(
    rules.displayNote || rules.customRules || rules.minEducation ||
    (Array.isArray(rules.requiredDocuments) && rules.requiredDocuments.length > 0) ||
    rules.requireMasterForDoctorate != null || rules.allowExperienceEquivalency != null
  )
}

function hasUnitObjectives(objectives?: string | null) {
  if (!objectives) return false
  try {
    const parsed = JSON.parse(objectives)
    return Array.isArray(parsed) && parsed.some((x) => String(x || '').trim().length > 6)
  } catch {
    return String(objectives || '').trim().length > 10
  }
}

function daysFromNow(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

async function buildProgramReadiness(programId: string) {
  const program = await db.program.findUnique({
    where: { id: programId },
    include: {
      books: { select: { id: true, semester: true } },
      units: { select: { id: true, objectives: true, exam: { select: { id: true } } } },
      assignments: { select: { id: true, status: true } },
      programExams: { select: { id: true, status: true, _count: { select: { questions: true } } } },
      _count: { select: { enrollments: true, admissions: true } },
    },
  })
  if (!program) return null

  const semestersCount = Math.max(1, Number(program.semestersCount || 2))
  const booksBySemester = Array.from({ length: semestersCount }, (_, i) => i + 1).map((semester) => ({
    semester,
    count: program.books.filter((b) => Number(b.semester || 1) === semester).length,
  }))
  const knowledgeItems = await db.bookKnowledgeItem.count({ where: { programId } })
  const readyExams = program.programExams.filter((e) => e.status === 'READY' && e._count.questions > 0).length
  const publishedAssignments = program.assignments.filter((a) => a.status === 'PUBLISHED').length
  const unitExams = program.units.filter((u) => !!u.exam).length
  const assessments = readyExams + publishedAssignments + unitExams
  const demandCount = program._count.enrollments + program._count.admissions

  const checks = {
    description: String(program.description || '').trim().length >= 40,
    admissionRules: safeJsonHasRules(program.admissionRules),
    semesters: semestersCount > 0,
    booksPerSemester: booksBySemester.every((s) => s.count >= 1),
    units: program.units.length > 0,
    unitObjectives: program.units.length > 0 && program.units.every((u) => hasUnitObjectives(u.objectives)),
    knowledge: knowledgeItems > 0,
    assessments: assessments > 0,
    manualApproval: !!program.academicApproved && program.academicReadinessStatus === 'APPROVED',
  }
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  const readyWithoutManualApproval = missing.filter((k) => k !== 'manualApproval').length === 0
  const isCurriculumReady = missing.length === 0

  return {
    id: program.id,
    slug: program.slug,
    titleAr: program.titleAr,
    titleEn: program.titleEn,
    category: program.category,
    demandCount,
    enrollments: program._count.enrollments,
    admissions: program._count.admissions,
    registrationStatus: program.registrationStatus,
    academicReadinessStatus: program.academicReadinessStatus,
    academicApproved: program.academicApproved,
    academicApprovedAt: program.academicApprovedAt,
    curriculumDueAt: program.curriculumDueAt,
    curriculumPreparationNote: program.curriculumPreparationNote,
    semestersCount,
    counts: {
      books: program.books.length,
      units: program.units.length,
      unitsWithObjectives: program.units.filter((u) => hasUnitObjectives(u.objectives)).length,
      knowledgeItems,
      exams: program.programExams.length + unitExams,
      readyExams,
      assignments: publishedAssignments,
      assessments,
    },
    targets: {
      books: semestersCount,
      units: Math.max(semestersCount * 4, 4),
      knowledgeItems: Math.max(program.books.length * 5, 1),
      assessments: 1,
    },
    booksBySemester,
    checks,
    missing,
    readyWithoutManualApproval,
    isCurriculumReady,
  }
}

// GET /api/admin/program-readiness — البرامج المسجل بها أو عليها طلبات وتحتاج تجهيز/اعتماد
export async function GET() {
  try {
    await requireAdmin()
    const demanded = await db.program.findMany({
      where: {
        active: true,
        OR: [
          { enrollments: { some: {} } },
          { admissions: { some: {} } },
        ],
      },
      select: { id: true },
      orderBy: { order: 'asc' },
    })

    const items = (await Promise.all(demanded.map((p) => buildProgramReadiness(p.id)))).filter(Boolean) as any[]
    const needsPreparation = items.filter((item) => !item.isCurriculumReady || item.registrationStatus !== 'OPEN')
    return NextResponse.json({ items: needsPreparation, generatedAt: new Date() })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program readiness GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل جاهزية البرامج' }, { status: 500 })
  }
}

// PATCH /api/admin/program-readiness — تحديث حالة المنهج/التسجيل أو اعتماد المنهج يدوياً
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const data: any = {}
    const readinessStatus = String(body?.academicReadinessStatus || '').trim().toUpperCase()
    const registrationStatus = String(body?.registrationStatus || '').trim().toUpperCase()
    if (READINESS_STATUSES.has(readinessStatus)) data.academicReadinessStatus = readinessStatus
    if (REGISTRATION_STATUSES.has(registrationStatus)) data.registrationStatus = registrationStatus
    if (body?.semestersCount != null) data.semestersCount = Math.max(1, Math.min(12, Number(body.semestersCount || 1)))
    if (body?.curriculumPreparationNote !== undefined) data.curriculumPreparationNote = cleanText(body.curriculumPreparationNote, 800)
    if (body?.setDue24h === true) data.curriculumDueAt = daysFromNow(1)

    if (body?.approve === true) {
      data.academicReadinessStatus = 'APPROVED'
      data.academicApproved = true
      data.academicApprovedAt = new Date()
      data.academicApprovedById = admin.id
      if (!data.registrationStatus) data.registrationStatus = 'OPEN'
    }
    if (body?.reopenPreparation === true) {
      data.academicReadinessStatus = 'IN_PREPARATION'
      data.academicApproved = false
      data.academicApprovedAt = null
      data.academicApprovedById = null
      if (!data.curriculumDueAt) data.curriculumDueAt = daysFromNow(1)
    }

    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'لا توجد تغييرات للحفظ' }, { status: 400 })
    await db.program.update({ where: { id: programId }, data })
    await audit({ id: admin.id, name: admin.name }, 'UPDATE_PROGRAM_READINESS', 'Program', programId, `تحديث جاهزية/اعتماد البرنامج: ${Object.keys(data).join(', ')}`)
    const item = await buildProgramReadiness(programId)
    return NextResponse.json({ ok: true, item })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program readiness PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث جاهزية البرنامج' }, { status: 500 })
  }
}
