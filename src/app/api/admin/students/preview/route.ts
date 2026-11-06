import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { calculateFinalGrade } from '@/lib/final-grade'
import { getEnrollmentDeadline, daysLeftUntil } from '@/lib/program-duration'
import { computeFollowUpStatus } from '@/lib/student-follow-up'

function safeJsonArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean).slice(0, 12) : []
  } catch {
    return []
  }
}

// حد رسائل المراسلات داخل المعاينة: آخر 100 رسالة لكل تبويب — سجل أطول من
// ذلك يُقرأ من شاشاته الأصلية (سجل المشرف الذكي / مراسلات الإدارة).
const MESSAGE_CAP = 100

function capMessageText(text?: string | null): string {
  const value = text || ''
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value
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
        status: true,
        lastActivityAt: true,
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

    const [admissions, enrollments, programAttempts, unitAttempts, assignments, theses, payments, certificates, microCredentials, chats, aiChatTotal, adminMessagesRaw] = await Promise.all([
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
          aiReview: true,
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
          extensionDays: true,
          followUpCount: true,
          createdAt: true,
          updatedAt: true,
          program: { select: { id: true, titleAr: true, category: true, hours: true, price: true, maxStudyDays: true, _count: { select: { units: true, books: true, programExams: true } } } },
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
          appealStatus: true,
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
        take: MESSAGE_CAP,
        select: { id: true, role: true, mode: true, kind: true, content: true, createdAt: true },
      }),
      db.chatMessage.count({ where: { userId: studentId } }),
      db.supervisorChannelMessage.findMany({
        where: { studentId, scope: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
        take: MESSAGE_CAP + 1,
        select: { id: true, senderRole: true, senderId: true, mode: true, content: true, createdAt: true },
      }),
    ])

    // ----- محاولات بانتظار البتّ البشري: حالتان متميزتان لا تُدمجان —
    // NEEDS_REVIEW (تصحيح بشري معلّق) وappealStatus PENDING (التماس قيد
    // الانتظار). تُجمع من المحاولات المحمّلة هنا ومن استعلامات التفاصيل.
    const pendingByKey = new Map<string, any>()
    const notePending = (kind: 'UNIT' | 'PROGRAM', a: any, examTitle: string, programTitle: string) => {
      const needsReview = a.status === 'NEEDS_REVIEW'
      const appealPending = a.appealStatus === 'PENDING'
      if (!needsReview && !appealPending) return
      const key = `${kind}:${a.id}`
      if (pendingByKey.has(key)) return
      pendingByKey.set(key, {
        attemptId: a.id,
        kind,
        examTitle,
        programTitle,
        needsReview,
        appealPending,
        createdAt: a.createdAt,
      })
    }
    for (const a of unitAttempts) notePending('UNIT', a, a.exam.title, a.exam.unit.program.titleAr)
    for (const a of programAttempts) notePending('PROGRAM', a, a.exam.title, a.exam.program.titleAr)

    // ----- تفاصيل التقدم لكل تسجيل نشط: المعدل التراكمي بمحرك الدرجات نفسه،
    // ونتيجة كل وحدة، وما تبقّى على الطالب. كلها مشتقة من بيانات مقروءة فقط.
    const activeEnrollments = enrollments.filter((e) => e.status === 'ACTIVE').slice(0, 5)
    const detailProgramIds = [...new Set(activeEnrollments.map((e) => e.program.id))]
    let enrollmentDetails: any[] = []
    let publishedAssignmentsTotal = 0
    if (detailProgramIds.length) {
      const [programUnits, unitVideos, watchRows, detailUnitAttempts, programExams, detailProgramAttempts, publishedAssignments, detailSubmissions, grades] = await Promise.all([
        db.unit.findMany({
          where: { programId: { in: detailProgramIds } },
          orderBy: [{ semester: 'asc' }, { order: 'asc' }],
          select: { id: true, title: true, semester: true, order: true, programId: true, exam: { select: { id: true, title: true, passScore: true, status: true } } },
        }),
        db.lectureVideoResource.findMany({
          where: { programId: { in: detailProgramIds }, unitId: { not: null }, status: 'PUBLISHED' },
          select: { id: true, unitId: true },
        }),
        db.lectureWatchProgress.findMany({
          where: { userId: studentId },
          select: { watchedPercent: true, completedAt: true, video: { select: { unitId: true } } },
        }),
        db.examAttempt.findMany({
          where: { userId: studentId, exam: { unit: { programId: { in: detailProgramIds } } } },
          orderBy: { createdAt: 'desc' },
          take: 300,
          select: { id: true, score: true, passed: true, status: true, appealStatus: true, submittedAt: true, createdAt: true, examId: true },
        }),
        db.programExam.findMany({
          where: { programId: { in: detailProgramIds } },
          orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, title: true, semester: true, passScore: true, status: true, programId: true },
        }),
        db.programExamAttempt.findMany({
          where: { userId: studentId, exam: { programId: { in: detailProgramIds } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, score: true, finalScore: true, passed: true, status: true, appealStatus: true, examId: true },
        }),
        db.programAssignment.findMany({
          where: { programId: { in: detailProgramIds }, status: 'PUBLISHED' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, title: true, semester: true, programId: true, points: true },
        }),
        db.assignmentSubmission.findMany({
          where: { userId: studentId, assignment: { programId: { in: detailProgramIds } } },
          take: 200,
          select: { id: true, status: true, score: true, assignmentId: true },
        }),
        Promise.all(activeEnrollments.map((e) => calculateFinalGrade({
          userId: studentId,
          programId: e.program.id,
          admissionId: admissions.find((a) => a.programId === e.program.id)?.id ?? null,
        }).catch(() => null))),
      ])
      publishedAssignmentsTotal = publishedAssignments.length
      const unitExamMeta = new Map<string, { examTitle: string; programTitle: string }>()
      for (const u of programUnits) {
        if (!u.exam) continue
        unitExamMeta.set(u.exam.id, { examTitle: u.exam.title, programTitle: activeEnrollments.find((e) => e.program.id === u.programId)?.program.titleAr || '' })
      }
      const programExamMeta = new Map<string, { examTitle: string; programTitle: string }>()
      for (const x of programExams) {
        programExamMeta.set(x.id, { examTitle: x.title, programTitle: activeEnrollments.find((e) => e.program.id === x.programId)?.program.titleAr || '' })
      }
      for (const a of detailUnitAttempts) {
        const meta = unitExamMeta.get(a.examId)
        if (meta) notePending('UNIT', a, meta.examTitle, meta.programTitle)
      }
      for (const a of detailProgramAttempts) {
        const meta = programExamMeta.get(a.examId)
        if (meta) notePending('PROGRAM', a, meta.examTitle, meta.programTitle)
      }

      enrollmentDetails = activeEnrollments.map((e, idx) => {
        const grade = grades[idx]
        const completedSet = new Set(safeJsonArray(e.completedUnits))
        const unitRows = programUnits.filter((u) => u.programId === e.program.id).map((u) => {
          const attempts = u.exam ? detailUnitAttempts.filter((a) => a.examId === u.exam!.id) : []
          const graded = attempts.filter((a) => a.status === 'GRADED')
          const bestScore = graded.reduce<number | null>((best, a) => (typeof a.score === 'number' ? (best == null ? a.score : Math.max(best, a.score)) : best), null)
          const passed = u.exam ? graded.some((a) => a.passed === true) || (bestScore != null && bestScore >= u.exam.passScore) : null
          const videosCount = unitVideos.filter((v) => v.unitId === u.id).length
          const rows = watchRows.filter((w) => w.video?.unitId === u.id)
          // «المشاهدة» هنا هي مشاهدة فيديوهات الوحدة المنشورة فقط — لا يوجد
          // تتبّع مستقل لقراءة نص الوحدة في المنصة، فلا ندّعيه.
          const watch = videosCount === 0 ? null : rows.some((w) => w.completedAt) ? 'COMPLETED' : rows.some((w) => (w.watchedPercent || 0) > 0) ? 'STARTED' : 'NONE'
          const completed = completedSet.has(u.id) || passed === true
          const state = completed ? 'COMPLETED' : attempts.length > 0 || watch === 'STARTED' || watch === 'COMPLETED' ? 'IN_PROGRESS' : 'NOT_STARTED'
          return {
            unitId: u.id,
            title: u.title,
            semester: u.semester,
            order: u.order,
            examId: u.exam?.id ?? null,
            examTitle: u.exam?.title ?? null,
            examStatus: u.exam?.status ?? null,
            passScore: u.exam?.passScore ?? null,
            attemptsCount: attempts.length,
            bestScore,
            passed,
            markedCompleted: completedSet.has(u.id),
            videosCount,
            watch,
            state,
          }
        })
        const programExamRows = programExams.filter((x) => x.programId === e.program.id).map((x) => {
          const atts = detailProgramAttempts.filter((a) => a.examId === x.id)
          return { examId: x.id, title: x.title, semester: x.semester, status: x.status, attemptsCount: atts.length, passed: atts.some((a) => a.passed === true) }
        })
        const assignmentRows = publishedAssignments.filter((a) => a.programId === e.program.id).map((a) => {
          const sub = detailSubmissions.find((s) => s.assignmentId === a.id)
          return { assignmentId: a.id, title: a.title, semester: a.semester, submitted: !!sub, status: sub?.status ?? null, score: sub?.score ?? null }
        })
        // حالة الغياب والمتابعة بنفس دالة لوحة الواجبات حرفيًا — لا صيغة جديدة.
        const followUpStatus = computeFollowUpStatus({
          lastActivityAt: student.lastActivityAt ?? null,
          baselineAt: new Date(e.createdAt),
          followUpCount: Number((e as any).followUpCount || 0),
        })
        const deadline = getEnrollmentDeadline(new Date(e.createdAt), e.program, e.extensionDays || 0)
        const thesisPending = grade ? grade.components.some((c) => (c.key === 'thesis' || c.key === 'defense') && !c.ready && !c.exempt) : false
        return {
          enrollmentId: e.id,
          programId: e.program.id,
          programTitle: e.program.titleAr,
          category: e.program.category,
          status: e.status,
          createdAt: e.createdAt,
          cumulative: grade ? {
            score: grade.score,
            earnedScore: grade.earnedScore,
            progressScore: grade.progressScore,
            weightSource: grade.weightSource,
            components: grade.components,
          } : null,
          followUp: {
            daysAbsent: followUpStatus.daysAbsent,
            followUpCount: followUpStatus.followUpCount,
            needsIntervention: followUpStatus.needsIntervention,
            lastActivityAt: student.lastActivityAt ?? null,
          },
          counts: {
            unitsTotal: unitRows.length,
            unitsCompleted: unitRows.filter((u) => u.state === 'COMPLETED').length,
            unitExamsTotal: unitRows.filter((u) => u.examId).length,
            unitExamsPassed: unitRows.filter((u) => u.passed === true).length,
            assignmentsTotal: assignmentRows.length,
            assignmentsSubmitted: assignmentRows.filter((a) => a.submitted).length,
            programExamsTotal: programExamRows.length,
            programExamsPassed: programExamRows.filter((x) => x.passed).length,
          },
          units: unitRows,
          programExams: programExamRows,
          assignments: assignmentRows,
          remaining: {
            unitsNotCompleted: unitRows.filter((u) => u.state !== 'COMPLETED').map((u) => u.title),
            unitExamsNotPassed: unitRows.filter((u) => u.examId && u.passed !== true).map((u) => u.title),
            assignmentsNotSubmitted: assignmentRows.filter((a) => !a.submitted).map((a) => a.title),
            programExamsNotPassed: programExamRows.filter((x) => !x.passed).map((x) => x.title),
            thesisPending,
            daysLeft: deadline ? daysLeftUntil(deadline) : null,
            gradeMissing: grade?.missing ?? [],
          },
        }
      })
    }

    const allScores = [
      ...programAttempts.map((a) => typeof (a.finalScore ?? a.score) === 'number' ? Number(a.finalScore ?? a.score) : null),
      ...unitAttempts.map((a) => typeof a.score === 'number' ? Number(a.score) : null),
    ].filter((x): x is number => typeof x === 'number')
    const completedPayments = payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    const unpaidPayments = payments.filter((p) => p.status !== 'PAID').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    // AcademicMemory.weaknesses is cumulative history. An earlier admission
    // analysis must never remain an "urgent" administrative warning after the
    // latest saved review confirms the documents are now satisfactory.
    const admissionSignals = admissions.flatMap((a) => {
      if (!a.aiReview || a.aiVerdict === 'RECOMMEND_APPROVE' || ['CERTIFIED', 'REJECTED'].includes(a.status)) return []
      try {
        const review = JSON.parse(a.aiReview)
        if (!Array.isArray(review?.findings)) return []
        return review.findings
          .filter((f: any) => f && ['HIGH', 'MEDIUM'].includes(f.severity) && f.title)
          .slice(0, 4)
          .map((f: any) => `طلب ${a.reference}: ${String(f.title).replace(/\s+/g, ' ').slice(0, 120)} — ${String(f.detail || '').replace(/\s+/g, ' ').slice(0, 180)}`)
      } catch {
        // A malformed older review is not proof of an active document issue.
        return []
      }
    })
    const atRiskSignals = [
      ...admissionSignals,
      ...programAttempts.filter((a) => a.passed === false || Number(a.score || 0) < 60).slice(0, 5).map((a) => `تعثر أو انخفاض في امتحان ${a.exam.title}`),
      ...assignments.filter((a) => a.status === 'NEEDS_REVISION').slice(0, 5).map((a) => `واجب يحتاج مراجعة: ${a.assignment.title}`),
    ].slice(0, 12)
    const pendingItems = [...pendingByKey.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20)
    const pendingReview = {
      needsReviewCount: [...pendingByKey.values()].filter((i) => i.needsReview).length,
      pendingAppealsCount: [...pendingByKey.values()].filter((i) => i.appealPending).length,
      items: pendingItems,
    }
    const adminMessagesCapped = adminMessagesRaw.length > MESSAGE_CAP
    const adminMessages = adminMessagesRaw.slice(0, MESSAGE_CAP)

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
        aiInteractions: aiChatTotal,
        atRiskSignals,
        examsSat: [...programAttempts, ...unitAttempts].filter((a) => ['GRADED', 'SUBMITTED', 'NEEDS_REVIEW'].includes(a.status)).length,
        assignmentsSolved: assignments.filter((a) => a.status === 'GRADED' || a.status === 'SUBMITTED').length,
        assignmentsPublishedTotal: publishedAssignmentsTotal,
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
      enrollmentDetails,
      absence: enrollmentDetails.length ? {
        ...enrollmentDetails[0].followUp,
        programTitle: enrollmentDetails[0].programTitle,
      } : null,
      pendingReview,
      correspondence: {
        aiSupervisor: {
          total: aiChatTotal,
          capped: aiChatTotal > chats.length,
          cap: MESSAGE_CAP,
          messages: [...chats].reverse().map((c) => ({ ...c, content: capMessageText(c.content) })),
        },
        admin: {
          total: adminMessages.length,
          capped: adminMessagesCapped,
          cap: MESSAGE_CAP,
          messages: adminMessages.map((m) => ({ ...m, content: capMessageText(m.content) })),
        },
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin student preview error:', e)
    return NextResponse.json({ error: 'تعذر تحميل معاينة الطالب' }, { status: 500 })
  }
}
