import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { enforceApiRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

function clean(value: unknown, max = 500) {
  return String(value || '').trim().slice(0, max)
}

async function buildStudentSummary(user: { id: string; email: string; name: string; country: string | null; status: string; createdAt: Date }) {
  const [enrollments, ownedAdmissions, unitAttempts, programAttempts, aiChats] = await Promise.all([
    db.enrollment.findMany({
      where: { userId: user.id },
      select: {
        status: true,
        certificateNo: true,
        finalScore: true,
        program: { select: { titleAr: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    db.admissionApplication.findMany({
      where: { userId: user.id },
      select: { id: true, reference: true, status: true, program: true, programRef: { select: { titleAr: true } }, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    db.examAttempt.findMany({
      where: { userId: user.id },
      select: { score: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.programExamAttempt.findMany({
      where: { userId: user.id },
      select: { score: true, finalScore: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.chatMessage.count({ where: { userId: user.id } }),
  ])

  const scorePool = [
    ...enrollments.map((e) => e.finalScore),
    ...unitAttempts.map((a) => a.score),
    ...programAttempts.flatMap((a) => [a.finalScore, a.score]),
  ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const latestAdmission = ownedAdmissions[0]

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    country: user.country,
    status: user.status,
    createdAt: user.createdAt,
    enrollments: enrollments.map((e) => ({
      program: e.program?.titleAr || 'برنامج غير محدد',
      status: e.status,
      certificateNo: e.certificateNo,
      finalScore: e.finalScore,
    })),
    attemptsCount: unitAttempts.length + programAttempts.length,
    bestScore: scorePool.length ? Math.max(...scorePool) : null,
    aiChats,
    latestAdmission: latestAdmission
      ? {
          id: latestAdmission.id,
          reference: latestAdmission.reference,
          status: latestAdmission.status,
          program: latestAdmission.programRef?.titleAr || latestAdmission.program || 'برنامج غير محدد',
          createdAt: latestAdmission.createdAt,
        }
      : null,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const userId = clean(req.nextUrl.searchParams.get('userId'), 120)
    if (userId) {
      const studentCore = await db.user.findFirst({
        where: { id: userId, role: 'STUDENT', enrollments: { some: {} } },
        select: { id: true, email: true, name: true, phone: true, country: true, status: true, createdAt: true, updatedAt: true },
      })
      if (!studentCore) return NextResponse.json({ error: 'الطالب غير موجود' }, { status: 404 })

      const [enrollments, ownedAdmissions, payments, examAttempts, programExamAttempts, assignmentSubmissions, theses, thesisTopicRequests, certificates] = await Promise.all([
        db.enrollment.findMany({
          where: { userId },
          include: { program: { select: { titleAr: true, category: true } }, payments: { select: { id: true, invoiceNo: true, status: true, amount: true, purpose: true, receiptNo: true, paidAt: true, createdAt: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        db.admissionApplication.findMany({
          where: { userId },
          select: { id: true, status: true, program: true, programRef: { select: { titleAr: true } }, reference: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        db.payment.findMany({
          where: { userId },
          select: { id: true, invoiceNo: true, status: true, amount: true, purpose: true, description: true, receiptNo: true, paidAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        db.examAttempt.findMany({
          where: { userId },
          include: { exam: { select: { title: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        db.programExamAttempt.findMany({
          where: { userId },
          include: { exam: { select: { title: true, program: { select: { titleAr: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        db.assignmentSubmission.findMany({
          where: { userId },
          include: { assignment: { select: { title: true, points: true, program: { select: { titleAr: true } } } } },
          orderBy: { submittedAt: 'desc' },
          take: 30,
        }),
        db.thesisSubmission.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
        db.thesisTopicRequest.findMany({
          where: { userId },
          include: { topic: { select: { title: true } }, program: { select: { titleAr: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        db.certificate.findMany({ where: { userId }, select: { id: true, serial: true, type: true, program: true, grade: true, issuedAt: true, valid: true }, orderBy: { issuedAt: 'desc' }, take: 20 }),
      ])

      return NextResponse.json({
        student: { ...studentCore, enrollments, ownedAdmissions, payments, examAttempts, programExamAttempts, assignmentSubmissions, theses, thesisTopicRequests, certificates },
      })
    }

    const q = clean(req.nextUrl.searchParams.get('q'), 120).toLowerCase()
    const status = clean(req.nextUrl.searchParams.get('status'), 40)
    const programId = clean(req.nextUrl.searchParams.get('programId'), 120)
    const paymentStatus = clean(req.nextUrl.searchParams.get('paymentStatus'), 40)
    const thesisStatus = clean(req.nextUrl.searchParams.get('thesisStatus'), 60)
    const where: any = { role: 'STUDENT', enrollments: { some: {} } }
    if (status && status !== 'ALL') where.status = status
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { country: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (programId && programId !== 'ALL') {
      where.enrollments = { some: { programId } }
    }
    if (paymentStatus && paymentStatus !== 'ALL') {
      where.payments = { some: { status: paymentStatus } }
    }
    if (thesisStatus && thesisStatus !== 'ALL') {
      where.theses = { some: { status: thesisStatus } }
    }

    const users = await db.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
      select: { id: true, email: true, name: true, country: true, status: true, createdAt: true },
    })
    const students = await Promise.all(users.map(buildStudentSummary))
    return NextResponse.json({ students })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin students GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الطلاب' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-students', 20, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json()
    const userId = clean(body?.userId, 120)
    const action = clean(body?.action, 60)
    if (!userId) return NextResponse.json({ error: 'معرف الطالب مطلوب' }, { status: 400 })
    const student = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, status: true } })
    if (!student || student.role !== 'STUDENT') return NextResponse.json({ error: 'الطالب غير موجود' }, { status: 404 })

    if (action === 'setStatus') {
      const status = clean(body?.status, 40)
      if (!['ACTIVE', 'DISABLED', 'ARCHIVED'].includes(status)) return NextResponse.json({ error: 'حالة غير صحيحة' }, { status: 400 })
      const updated = await db.user.update({
        where: { id: userId },
        data: { status, archivedAt: status === 'ARCHIVED' ? new Date() : null },
      })
      await audit({ id: admin.id, name: admin.name }, 'UPDATE_STUDENT_STATUS', 'User', userId, `تحديث حالة الطالب ${student.email} إلى ${status}`)
      return NextResponse.json({ ok: true, student: updated })
    }

    if (action === 'cancelEnrollment') {
      const enrollmentId = clean(body?.enrollmentId, 120)
      if (!enrollmentId) return NextResponse.json({ error: 'معرف التسجيل مطلوب' }, { status: 400 })
      const enrollment = await db.enrollment.findFirst({ where: { id: enrollmentId, userId }, include: { payments: true } })
      if (!enrollment) return NextResponse.json({ error: 'التسجيل غير موجود' }, { status: 404 })
      const hasPaid = enrollment.payments.some((p) => p.status === 'PAID')
      if (hasPaid) return NextResponse.json({ error: 'لا يمكن إلغاء تسجيل مرتبط بمدفوعات مدفوعة. استخدم التعطيل أو الأرشفة.' }, { status: 400 })
      await db.enrollment.delete({ where: { id: enrollmentId } })
      await audit({ id: admin.id, name: admin.name }, 'CANCEL_STUDENT_ENROLLMENT', 'Enrollment', enrollmentId, `إلغاء تسجيل الطالب ${student.email}`)
      return NextResponse.json({ ok: true })
    }

    if (action === 'safeDelete') {
      const blockers = await Promise.all([
        db.payment.count({ where: { userId, status: 'PAID' } }),
        db.certificate.count({ where: { userId } }),
        db.examAttempt.count({ where: { userId } }),
        db.programExamAttempt.count({ where: { userId } }),
        db.assignmentSubmission.count({ where: { userId } }),
        db.thesisSubmission.count({ where: { userId } }),
      ])
      const totalBlockers = blockers.reduce((a, b) => a + b, 0)
      if (totalBlockers > 0) {
        return NextResponse.json({ error: 'لا يمكن حذف طالب لديه سجلات أكاديمية/مدفوعات/شهادات. يمكن تعطيله أو أرشفته فقط.' }, { status: 400 })
      }
      await db.user.delete({ where: { id: userId } })
      await audit({ id: admin.id, name: admin.name }, 'SAFE_DELETE_STUDENT', 'User', userId, `حذف آمن لطالب تجريبي ${student.email}`)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin students PATCH error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الطالب' }, { status: 500 })
  }
}
