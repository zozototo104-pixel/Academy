import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { academicProfileFromRules, buildAcademicProgramProfile } from '@/lib/program-tracks'

function toIso(value?: Date | string | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function gradeLabel(score?: number | null): string | null {
  if (score == null || !Number.isFinite(score)) return null
  if (score >= 90) return 'امتياز'
  if (score >= 80) return 'جيد جداً'
  if (score >= 70) return 'جيد'
  if (score >= 60) return 'مقبول'
  return 'غير مجتاز'
}

async function resolveCertificateOwnerUserId(cert: { userId?: string | null; admissionId?: string | null }): Promise<string | null> {
  if (cert.userId) return cert.userId
  if (!cert.admissionId) return null
  const admission = await db.admissionApplication.findUnique({ where: { id: cert.admissionId }, select: { userId: true } }).catch(() => null)
  return admission?.userId || null
}

async function buildCertificateAcademicRecord(cert: { userId?: string | null; admissionId?: string | null; enrollmentId?: string | null; program: string }) {
  const userId = await resolveCertificateOwnerUserId(cert)
  if (!userId) return null

  const program = await db.program.findFirst({
    where: { titleAr: cert.program },
    select: { id: true, titleAr: true, titleEn: true, category: true, hours: true },
  }).catch(() => null)
  if (!program) return null

  const [enrollment, unitAttempts, programAttempts, assignments, thesis] = await Promise.all([
    db.enrollment.findFirst({
      where: cert.enrollmentId ? { id: cert.enrollmentId } : { userId, programId: program.id },
      select: { id: true, status: true, finalScore: true, certificateNo: true, createdAt: true, updatedAt: true },
    }).catch(() => null),
    db.examAttempt.findMany({
      where: { userId, exam: { unit: { programId: program.id } } },
      orderBy: { submittedAt: 'desc' },
      take: 40,
      select: {
        id: true,
        score: true,
        passed: true,
        status: true,
        submittedAt: true,
        exam: { select: { title: true, passScore: true, unit: { select: { order: true, title: true } } } },
      },
    }).catch(() => []),
    db.programExamAttempt.findMany({
      where: { userId, exam: { programId: program.id } },
      orderBy: { submittedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        score: true,
        passed: true,
        status: true,
        submittedAt: true,
        exam: { select: { title: true, semester: true, passScore: true, totalPoints: true } },
      },
    }).catch(() => []),
    db.assignmentSubmission.findMany({
      where: { userId, assignment: { programId: program.id } },
      orderBy: { submittedAt: 'desc' },
      take: 30,
      select: {
        id: true,
        status: true,
        score: true,
        feedback: true,
        submittedAt: true,
        gradedAt: true,
        assignment: { select: { title: true, semester: true, type: true, points: true, weight: true } },
      },
    }).catch(() => []),
    db.thesisSubmission.findFirst({
      where: { userId, admission: { programId: program.id } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        aiScore: true,
        resultScore: true,
        passed: true,
        defenseStatus: true,
        defenseDate: true,
        defenseCompletedAt: true,
        reviewedAt: true,
        aiRecommendation: true,
        committee: true,
      },
    }).catch(() => null),
  ])

  const examScores = [...unitAttempts.map((a) => a.score), ...programAttempts.map((a) => a.score)].filter((x): x is number => typeof x === 'number')
  const avgExamScore = examScores.length ? Math.round((examScores.reduce((a, b) => a + b, 0) / examScores.length) * 10) / 10 : null
  const finalScore = enrollment?.finalScore ?? thesis?.resultScore ?? avgExamScore

  return {
    program: {
      id: program.id,
      titleAr: program.titleAr,
      titleEn: program.titleEn,
      category: program.category,
      hours: program.hours,
    },
    enrollment: enrollment ? {
      id: enrollment.id,
      status: enrollment.status,
      finalScore: enrollment.finalScore,
      certificateNo: enrollment.certificateNo,
      startedAt: toIso(enrollment.createdAt),
      updatedAt: toIso(enrollment.updatedAt),
    } : null,
    summary: {
      finalScore,
      gradeLabel: gradeLabel(finalScore),
      unitExamCount: unitAttempts.length,
      comprehensiveExamCount: programAttempts.length,
      assignmentCount: assignments.length,
      thesisStatus: thesis?.status || null,
      committeeDecision: thesis?.passed === true ? 'اجتاز مناقشة/بحث التخرج' : thesis?.passed === false ? 'لم يجتز بعد' : thesis ? 'قيد المراجعة أو بانتظار قرار اللجنة' : 'لا يوجد بحث تخرج مسجل',
    },
    unitExams: unitAttempts.map((a) => ({
      title: a.exam.title,
      unitTitle: a.exam.unit.title,
      unitOrder: a.exam.unit.order,
      score: a.score,
      passed: a.passed,
      status: a.status,
      passScore: a.exam.passScore,
      submittedAt: toIso(a.submittedAt),
    })),
    comprehensiveExams: programAttempts.map((a) => ({
      title: a.exam.title,
      semester: a.exam.semester,
      score: a.score,
      passed: a.passed,
      status: a.status,
      passScore: a.exam.passScore,
      totalPoints: a.exam.totalPoints,
      submittedAt: toIso(a.submittedAt),
    })),
    assignments: assignments.map((a) => ({
      title: a.assignment.title,
      semester: a.assignment.semester,
      type: a.assignment.type,
      score: a.score,
      maxPoints: a.assignment.points,
      weight: a.assignment.weight,
      status: a.status,
      submittedAt: toIso(a.submittedAt),
      gradedAt: toIso(a.gradedAt),
    })),
    thesis: thesis ? {
      title: thesis.title,
      status: thesis.status,
      defenseStatus: thesis.defenseStatus,
      score: thesis.resultScore ?? thesis.aiScore,
      passed: thesis.passed,
      defenseDate: toIso(thesis.defenseDate),
      completedAt: toIso(thesis.defenseCompletedAt),
      reviewedAt: toIso(thesis.reviewedAt),
      committee: thesis.committee,
      recommendation: thesis.aiRecommendation,
    } : null,
  }
}

// GET /api/certificates/verify?serial=AACT-C-2026-00001 — تحقق عام من صحة الشهادة
export async function GET(req: NextRequest) {
  try {
    const serial = req.nextUrl.searchParams.get('serial')?.trim()
    const token = req.nextUrl.searchParams.get('token')?.trim()
    if (!serial && !token) {
      return NextResponse.json({ error: 'يرجى إدخال رقم الشهادة' }, { status: 400 })
    }
    const cert = await db.certificate.findFirst({
      where: serial ? { serial } : { qrToken: token! },
    })
    if (!cert) {
      return NextResponse.json({ valid: false, message: 'لا توجد شهادة بهذا الرقم — تأكد من الرقم أو تواصل مع الإدارة' })
    }
    const program = cert.program
      ? await db.program.findFirst({
          where: { titleAr: cert.program },
          select: {
            titleAr: true, titleEn: true, description: true, category: true, hours: true, admissionRules: true,
            units: { orderBy: { order: 'asc' }, select: { order: true, title: true } },
            books: { orderBy: { createdAt: 'asc' }, select: { title: true, titleEn: true, semester: true } },
            assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { title: true, semester: true, points: true, status: true } },
            programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { title: true, semester: true, status: true, _count: { select: { questions: true } } } },
            _count: { select: { units: true } },
          },
        }).catch(() => null)
      : null
    const academicProfile = program
      ? buildAcademicProgramProfile({
          titleAr: program.titleAr,
          titleEn: program.titleEn,
          description: program.description,
          category: program.category,
          hours: program.hours,
          unitsCount: program._count.units,
          units: program.units,
          books: program.books,
          assignments: program.assignments,
          exams: program.programExams.map((e) => ({ title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
          academicProfile: academicProfileFromRules(program.admissionRules),
        })
      : null
    const academicRecord = await buildCertificateAcademicRecord(cert)
    return NextResponse.json({
      valid: cert.valid,
      certificate: {
        serial: cert.serial,
        type: cert.type,
        holderName: cert.holderName,
        program: cert.program,
        grade: cert.grade,
        country: cert.country,
        issuedAt: cert.issuedAt,
        valid: cert.valid,
        academicProfile,
        academicRecord,
      },
      message: cert.valid
        ? 'شهادة صحيحة ومسجلة رسمياً في سجلات الأكاديمية الأمريكية للاستشارات والتدريب'
        : 'الشهادة موجودة لكنها موقوفة — يرجى التواصل مع الإدارة',
    })
  } catch (e) {
    console.error('certificates verify error:', e)
    return NextResponse.json({ error: 'تعذر التحقق من الشهادة' }, { status: 500 })
  }
}
