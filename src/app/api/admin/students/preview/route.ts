import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

function safeJsonArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean).slice(0, 12) : []
  } catch {
    return []
  }
}

export const dynamic = 'force-dynamic'

// GET /api/admin/students/preview?studentId=xxx
// صفحة معاينة/مراقبة للمدير فقط — قراءة ومتابعة، وليست تقمصاً لحساب الطالب ولا تسمح بالدفع أو التسليم نيابة عنه.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const studentId = req.nextUrl.searchParams.get('studentId')?.trim()
    if (!studentId) return NextResponse.json({ error: 'معرف الطالب مطلوب' }, { status: 400 })

    const student = await db.user.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        role: true,
        createdAt: true,
        academicMemory: {
          select: {
            profileDigest: true,
            strengths: true,
            weaknesses: true,
            conceptsToReview: true,
            recommendedNextActions: true,
            lastConversationSummary: true,
            lastFileAnalysis: true,
            lastInteractionAt: true,
            lastExamAt: true,
            lastDefenseAt: true,
            interactionsCount: true,
          },
        },
      },
    })
    if (!student) return NextResponse.json({ error: 'الطالب غير موجود' }, { status: 404 })
    if (student.role !== 'STUDENT') {
      return NextResponse.json({ error: 'المعاينة الإدارية مخصصة لحسابات الطلاب فقط، وليست لحسابات الإدارة أو المشرفين.' }, { status: 400 })
    }

    const [admissions, enrollments, programAttempts, unitAttempts, assignments, theses, payments, certificates, microCredentials, chats] = await Promise.all([
      db.admissionApplication.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          reference: true,
          fullName: true,
          program: true,
          programId: true,
          status: true,
          aiVerdict: true,
          aiScore: true,
          aiReviewedAt: true,
          supervisorAt: true,
          approvedAt: true,
          thesisDeadline: true,
          createdAt: true,
          supervisor: { select: { id: true, name: true } },
          files: { select: { id: true, docType: true, fileName: true, size: true } },
          payments: { select: { invoiceNo: true, purpose: true, amount: true, status: true, paidAt: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
      db.enrollment.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          completedUnits: true,
          finalScore: true,
          certificateNo: true,
          createdAt: true,
          updatedAt: true,
          program: { select: { id: true, titleAr: true, category: true, hours: true, price: true, _count: { select: { units: true, books: true, programExams: true } } } },
        },
      }),
      db.programExamAttempt.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          score: true,
          finalScore: true,
          passed: true,
          status: true,
          appealStatus: true,
          appealReason: true,
          durationUsedMin: true,
          submittedAt: true,
          createdAt: true,
          exam: { select: { id: true, title: true, semester: true, program: { select: { id: true, titleAr: true, category: true } } } },
        },
      }),
      db.examAttempt.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          score: true,
          passed: true,
          status: true,
          submittedAt: true,
          createdAt: true,
          exam: { select: { id: true, title: true, unit: { select: { title: true, program: { select: { id: true, titleAr: true } } } } } },
        },
      }),
      db.assignmentSubmission.findMany({
        where: { userId: studentId },
        orderBy: { submittedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          score: true,
          feedback: true,
          fileName: true,
          submittedAt: true,
          gradedAt: true,
          assignment: { select: { id: true, title: true, semester: true, type: true, points: true, program: { select: { id: true, titleAr: true } } } },
        },
      }),
      db.thesisSubmission.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          title: true,
          abstract: true,
          status: true,
          defenseDate: true,
          aiScore: true,
          aiRecommendation: true,
          resultScore: true,
          passed: true,
          defenseStatus: true,
          defenseCompletedAt: true,
          recordingSize: true,
          recordingDurationSec: true,
          createdAt: true,
          admission: { select: { reference: true, program: true, status: true } },
          _count: { select: { defenseMessages: true, defenseParticipants: true } },
        },
      }),
      db.payment.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          invoiceNo: true,
          purpose: true,
          description: true,
          amount: true,
          currency: true,
          status: true,
          receiptNo: true,
          paidAt: true,
          createdAt: true,
        },
      }),
      db.certificate.findMany({
        where: { userId: studentId },
        orderBy: { issuedAt: 'desc' },
        take: 20,
        select: { id: true, serial: true, type: true, holderName: true, program: true, grade: true, valid: true, issuedAt: true },
      }),
      db.userMicroCredential.findMany({
        where: { userId: studentId },
        orderBy: { issuedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          source: true,
          valid: true,
          issuedAt: true,
          revokedAt: true,
          revokedReason: true,
          microCredential: { select: { titleAr: true, titleEn: true, skillArea: true, badgeCode: true, program: { select: { titleAr: true } } } },
        },
      }),
      db.chatMessage.findMany({
        where: { userId: studentId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, role: true, mode: true, kind: true, content: true, createdAt: true },
      }),
    ])

    const allScores = [
      ...programAttempts.map((a) => typeof (a.finalScore ?? a.score) === 'number' ? Number(a.finalScore ?? a.score) : null),
      ...unitAttempts.map((a) => typeof a.score === 'number' ? Number(a.score) : null),
    ].filter((x): x is number => typeof x === 'number')
    const completedPayments = payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const unpaidPayments = payments.filter((p) => p.status !== 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const atRiskSignals = [
      ...(student.academicMemory ? safeJsonArray(student.academicMemory.weaknesses) : []),
      ...programAttempts.filter((a) => a.passed === false || Number(a.score || 0) < 60).slice(0, 5).map((a) => `تعثر أو انخفاض في امتحان ${a.exam.title}`),
      ...assignments.filter((a) => a.status === 'NEEDS_REVISION').slice(0, 5).map((a) => `واجب يحتاج مراجعة: ${a.assignment.title}`),
    ].slice(0, 12)

    return NextResponse.json({
      previewMode: 'ADMIN_READ_ONLY',
      note: 'هذه معاينة إدارية للمتابعة فقط؛ لا تسمح بالدفع أو حل الاختبارات أو تسليم الواجبات نيابة عن الطالب.',
      student: {
        ...student,
        academicMemory: student.academicMemory ? {
          ...student.academicMemory,
          strengths: safeJsonArray(student.academicMemory.strengths),
          weaknesses: safeJsonArray(student.academicMemory.weaknesses),
          conceptsToReview: safeJsonArray(student.academicMemory.conceptsToReview),
          recommendedNextActions: safeJsonArray(student.academicMemory.recommendedNextActions),
        } : null,
      },
      overview: {
        admissions: admissions.length,
        enrollments: enrollments.length,
        activeEnrollments: enrollments.filter((e) => e.status === 'ACTIVE').length,
        completedEnrollments: enrollments.filter((e) => e.status === 'COMPLETED').length,
        programExamAttempts: programAttempts.length,
        unitExamAttempts: unitAttempts.length,
        assignments: assignments.length,
        theses: theses.length,
        certificates: certificates.length,
        microCredentials: microCredentials.filter((m) => m.valid).length,
        averageScore: allScores.length ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : null,
        paidTotal: completedPayments,
        unpaidTotal: unpaidPayments,
        aiInteractions: chats.length,
        atRiskSignals,
      },
      admissions,
      enrollments: enrollments.map((e) => ({
        ...e,
        completedUnitsCount: safeJsonArray(e.completedUnits).length,
      })),
      programAttempts,
      unitAttempts,
      assignments,
      theses: theses.map((t) => ({
        ...t,
        abstract: t.abstract?.length > 600 ? `${t.abstract.slice(0, 600)}...` : t.abstract,
        aiRecommendation: t.aiRecommendation?.length && t.aiRecommendation.length > 700 ? `${t.aiRecommendation.slice(0, 700)}...` : t.aiRecommendation,
        hasRecording: !!t.recordingSize,
      })),
      payments,
      certificates,
      microCredentials,
      recentChats: chats.map((c) => ({ ...c, content: c.content.length > 420 ? `${c.content.slice(0, 420)}...` : c.content })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin student preview error:', e)
    return NextResponse.json({ error: 'تعذر تحميل معاينة الطالب' }, { status: 500 })
  }
}
