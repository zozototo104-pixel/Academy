import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getExamsGate } from '@/lib/exam-gate'
import { academicProfileFromRules } from '@/lib/program-tracks'
import { calculateSemesterReadiness, markSemesterReady } from '@/lib/semester-readiness'
import { calculateFinalGrade, pickBestGradedAttempt } from '@/lib/final-grade'
import { getStudentSemesterTracking } from '@/lib/student-tracking'
import { enforceSemesterTuitionGate, getStudentTuitionPlan } from '@/lib/tuition-installments'
import { registerGraduationRequest } from '@/lib/enrollment-completion'
import { matureSemesterRaisesAfterGrading } from '@/lib/semester-raise-hooks'
import { SEMESTER_DECISION_ACTIVE, withdrawSemesterRaise } from '@/lib/semester-decision'
import { getSemesterDecisionBrief, requestSemesterDecision } from '@/lib/semester-raise'

// GET /api/progress?programId=xxx — تفاصيل البرنامج مع وحداته وتقدم الطالب
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const programId = req.nextUrl.searchParams.get('programId')
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId } },
    })
    if (!enrollment) {
      return NextResponse.json({ error: 'أنت غير مسجل في هذا البرنامج' }, { status: 403 })
    }
    if (!['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      return NextResponse.json(
        { error: 'تسجيلك غير مفعّل — افتح بوابة الدفعات لاستكمال السداد أو اعتماد الإعفاء', code: 'ENROLLMENT_NOT_ACTIVE' },
        { status: 403 }
      )
    }

    const program = await db.program.findUnique({
      where: { id: programId },
      include: {
        units: {
          orderBy: { order: 'asc' },
          include: { exam: { select: { id: true, title: true, passScore: true } } },
        },
        books: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, titleEn: true, semester: true, source: true, fileName: true, storageKey: true, fileUrl: true, link: true } },
        assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, points: true, status: true } },
        programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { id: true, title: true, semester: true, status: true, _count: { select: { questions: true } } } },
      },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    // أفضل محاولة لكل اختبار
    const examIds = program.units.map((u) => u.exam?.id).filter(Boolean) as string[]
    const attempts = examIds.length
      ? await db.examAttempt.findMany({
          where: { userId: user.id, examId: { in: examIds } },
          orderBy: { submittedAt: 'desc' },
        })
      : []
    // أفضل محاولة لكل اختبار بنفس قاعدة محرك المعدل النهائي: المحاولات
    // المعتمدة (GRADED) فقط وأعلى علامة بينها — لا أحدث محاولة.
    const bestByExam: Record<string, { score: number; passed: boolean }> = {}
    const attemptsByExam = new Map<string, typeof attempts>()
    for (const a of attempts) {
      if (!a.examId) continue
      const list = attemptsByExam.get(a.examId)
      if (list) list.push(a)
      else attemptsByExam.set(a.examId, [a])
    }
    for (const [examId, examAttempts] of attemptsByExam) {
      const bestAttempt = pickBestGradedAttempt(examAttempts)
      if (bestAttempt) bestByExam[examId] = { score: bestAttempt.score as number, passed: !!bestAttempt.passed }
    }

    const completedUnits: string[] = JSON.parse(enrollment.completedUnits || '[]')
    const totalUnits = program.units.length
    const progress = totalUnits ? Math.round((completedUnits.length / totalUnits) * 100) : 0

    // 12.2: امتحانا الفصلين المبنيان على الكتب المقررة + عدد الكتب
    const [readyExams, reviewCount, booksCount, knowledgeCount] = await Promise.all([
      db.programExam.findMany({
        where: { programId, status: 'READY' },
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
      }),
      db.programExam.count({ where: { programId, status: 'REVIEW' } }),
      db.book.count({ where: { programId } }),
      db.bookKnowledgeItem.count({ where: { programId } }),
    ])

    const examMeta = await Promise.all(
      readyExams.map(async (e) => {
        const qCount = await db.programQuestion.count({ where: { examId: e.id, status: 'PUBLISHED' } })
        const best = await db.programExamAttempt.findFirst({
          where: { userId: user.id, examId: e.id, score: { not: null } },
          orderBy: { score: 'desc' },
        })
        return {
          id: e.id,
          title: e.title,
          semester: e.semester,
          durationMin: e.durationMin,
          passScore: e.passScore,
          questionCount: qCount,
          bestScore: best?.score ?? null,
          passed: best ? !!best.passed : false,
        }
      })
    )
    const semesterExams = examMeta.filter((e) => e.questionCount > 0)
    const semesterReadiness = await Promise.all(
      semesterExams.map((e) => calculateSemesterReadiness(user.id, programId, e.semester))
    )
    // موجز قرار إنهاء الفصل لكل فصل (سجل القرار): وقائع النافذة وحالة
    // الطلب من مصدر الخادم الوحيد. يُحسب فقط عند تفعيل الميزة، ودفاعي
    // لكل فصل: أي فشل يترك الموجز فارغًا ولا يُسقط بقية التقدم.
    const decisionBriefs = SEMESTER_DECISION_ACTIVE
      ? await Promise.all(
          semesterExams.map(async (e) => {
            try {
              return await getSemesterDecisionBrief(db, {
                enrollmentId: enrollment.id,
                userId: user.id,
                programId,
                semester: e.semester,
                enrollment: {
                  createdAt: enrollment.createdAt,
                  status: enrollment.status,
                  extensionDays: enrollment.extensionDays,
                },
                program: {
                  category: program.category,
                  maxStudyDays: program.maxStudyDays,
                  semestersCount: program.semestersCount,
                },
              })
            } catch {
              return null
            }
          }),
        )
      : semesterExams.map(() => null)
    const [tuitionPlan, grade] = await Promise.all([
      getStudentTuitionPlan(user.id, programId),
      calculateFinalGrade({ userId: user.id, programId }),
    ])
    const semesterTracking = await getStudentSemesterTracking(db, { userId: user.id, programId, finalGrade: grade }).catch(() => null)
    const finalExam = semesterExams[0] || null

    return NextResponse.json({
      program: {
        id: program.id,
        slug: program.slug,
        titleAr: program.titleAr,
        titleEn: program.titleEn,
        description: program.description,
        category: program.category,
        hours: program.hours,
        price: program.price,
        unitsCount: program.units.length,
        units: program.units.map((u) => ({ id: u.id, order: u.order, title: u.title })),
        books: program.books.map((b) => ({
          id: b.id,
          title: b.title,
          titleEn: b.titleEn,
          semester: b.semester,
          source: b.source,
          fileName: b.fileName,
          hasFile: Boolean(b.fileName || b.storageKey || b.fileUrl),
          hasLink: Boolean(b.link),
        })),
        assignments: program.assignments,
        exams: program.programExams.map((e) => ({ id: e.id, title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
        academicProfile: academicProfileFromRules(program.admissionRules),
        curriculumReadiness: {
          status: program.academicReadinessStatus,
          registrationStatus: program.registrationStatus,
          approved: !!program.academicApproved && program.academicReadinessStatus === 'APPROVED',
          dueAt: program.curriculumDueAt,
          note: program.curriculumPreparationNote,
          counts: {
            books: booksCount,
            units: program.units.length,
            unitsWithObjectives: program.units.filter((u) => Boolean(u.objectives && String(u.objectives).trim().length > 8)).length,
            knowledgeItems: knowledgeCount,
            readyExams: readyExams.length,
            reviewExams: reviewCount,
          },
          message: 'جاري تجهيز المنهج الأكاديمي لهذا التخصص. سيتم تجهيز الكتب والوحدات وبنك المعرفة خلال 24 ساعة من اعتماد التسجيل.',
        },
      },
      progress,
      status: enrollment.status,
      finalScore: enrollment.finalScore,
      gradeProgress: {
        score: grade.score,
        earned: grade.progressScore,
        complete: grade.score !== null,
        components: grade.components,
        missing: grade.missing,
        weightSource: grade.weightSource,
        weightWarning: grade.weightWarning || null,
      },
      semesterTracking,
      completedUnits,
      booksCount,
      finalExam,
      pendingReviewExams: reviewCount,
      decisionActive: SEMESTER_DECISION_ACTIVE,
      semesterExams: semesterExams.map((exam, examIndex) => {
        const requiredAmount = exam.semester >= 2 ? tuitionPlan?.finalRequired ?? 0 : tuitionPlan?.halfRequired ?? 0
        const allowed = !tuitionPlan || tuitionPlan.totalTuition <= 0 || (exam.semester >= 2 ? tuitionPlan.secondSemesterAllowed : tuitionPlan.firstSemesterAllowed)
        return {
          ...exam,
          readiness: semesterReadiness.find((r) => r.semester === exam.semester) || null,
          decisionBrief: decisionBriefs[examIndex] ?? null,
          tuitionGate: {
            allowed,
            code: allowed ? null : exam.semester >= 2 ? 'TUITION_FULL_REQUIRED' : 'TUITION_HALF_REQUIRED',
            totalTuition: tuitionPlan?.totalTuition ?? 0,
            paidTuition: tuitionPlan?.paidTuition ?? 0,
            requiredAmount,
            remainingTuition: tuitionPlan?.remainingTuition ?? 0,
            message: allowed
              ? null
              : exam.semester >= 2
              ? `لا يمكن فتح امتحان الفصل الثاني قبل سداد كامل الرسوم الدراسية. المسدد حالياً ${tuitionPlan?.paidTuition ?? 0}$ والمطلوب ${requiredAmount}$.`
              : `لا يمكن فتح امتحان الفصل الأول قبل سداد نصف الرسوم الدراسية على الأقل. المسدد حالياً ${tuitionPlan?.paidTuition ?? 0}$ والمطلوب ${requiredAmount}$.`,
          },
        }
      }),
      units: program.units.map((u) => ({
        id: u.id,
        order: u.order,
        title: u.title,
        summary: u.summary,
        hasExam: !!u.exam,
        examId: u.exam?.id || null,
        examTitle: u.exam?.title || null,
        examPassScore: u.exam?.passScore || null,
        bestScore: u.exam ? bestByExam[u.exam.id]?.score ?? null : null,
        examPassed: u.exam ? bestByExam[u.exam.id]?.passed ?? false : false,
        completed: completedUnits.includes(u.id),
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Progress GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل التقدم' }, { status: 500 })
  }
}

// POST /api/progress — تحديث تقدم الطالب (إكمال وحدة)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { programId, unitId, action, semester, intent } = await req.json()
    if (action === 'SEMESTER_DECISION' || action === 'SEMESTER_DECISION_WITHDRAW') {
      // قرار إنهاء الفصل بيد الطالب: النضج يُشتق على الخادم دائمًا،
      // ولا يُقبل أي اختيار قبل تفعيل الميزة (الصمّام).
      if (!SEMESTER_DECISION_ACTIVE) {
        return NextResponse.json({ error: 'ميزة قرار إنهاء الفصل غير مفعّلة بعد', code: 'SEMESTER_DECISION_INACTIVE' }, { status: 409 })
      }
      if (!programId || !semester) return NextResponse.json({ error: 'معرف البرنامج والفصل مطلوبان' }, { status: 400 })
      const enrollment = await db.enrollment.findUnique({
        where: { userId_programId: { userId: user.id, programId } },
      })
      if (!enrollment) return NextResponse.json({ error: 'غير مسجل في البرنامج' }, { status: 403 })
      const program = await db.program.findUnique({
        where: { id: programId },
        select: { category: true, maxStudyDays: true, semestersCount: true },
      })
      if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
      const DECISION_ERRORS: Record<string, string> = {
        ENROLLMENT_NOT_FOUND: 'التسجيل غير موجود',
        INVALID_SEMESTER: 'فصل غير صالح لهذا البرنامج',
        SEMESTER_ALREADY_DECIDED: 'نتيجة هذا الفصل معتمدة — لا يمكن تغيير القرار',
        SEMESTER_PERIOD_ENDED: 'انتهت فترة هذا الفصل — تُرفع النتيجة للإدارة تلقائيًا عند اكتمال التصحيح',
        SEMESTER_ALREADY_RAISED: 'نتيجتك مرفوعة بالفعل — يمكنك سحب الطلب بدل تغيير الاختيار',
        NO_ACTIVE_RAISE: 'لا يوجد طلب رفع قائم لسحبه',
      }
      if (action === 'SEMESTER_DECISION_WITHDRAW') {
        const result = await withdrawSemesterRaise(db, {
          enrollmentId: enrollment.id,
          userId: user.id,
          semester: Number(semester),
        })
        if (!result.ok) {
          return NextResponse.json(
            { error: DECISION_ERRORS[result.code] || 'تعذر سحب الطلب', code: result.code },
            { status: 409 },
          )
        }
        return NextResponse.json({ ok: true, decision: result.decision })
      }
      if (intent !== 'EARLY_FINISH' && intent !== 'CONTINUE') {
        return NextResponse.json({ error: 'اختيار غير صالح', code: 'INVALID_INTENT' }, { status: 400 })
      }
      const result = await requestSemesterDecision(db, {
        enrollmentId: enrollment.id,
        userId: user.id,
        programId,
        semester: Number(semester),
        intent,
        enrollment: {
          createdAt: enrollment.createdAt,
          status: enrollment.status,
          extensionDays: enrollment.extensionDays,
        },
        program,
      })
      if (!result.ok) {
        return NextResponse.json(
          { error: DECISION_ERRORS[result.code] || 'تعذر حفظ القرار', code: result.code },
          { status: 409 },
        )
      }
      return NextResponse.json({
        ok: true,
        decision: result.decision,
        maturity: {
          mature: result.maturity.mature,
          examTaken: result.maturity.examTaken,
          examPublished: result.maturity.examPublished,
          blockers: result.maturity.blockers,
        },
      })
    }
    if (action === 'READY_FOR_EXAM') {
      if (!programId || !semester) return NextResponse.json({ error: 'معرف البرنامج والفصل مطلوبان' }, { status: 400 })
      const tuitionGate = await enforceSemesterTuitionGate(user.id, programId, Number(semester))
      if (!tuitionGate.ok) {
        return NextResponse.json({ error: tuitionGate.error, code: tuitionGate.code, tuitionPlan: tuitionGate.plan }, { status: 402 })
      }
      const readiness = await markSemesterReady(user.id, programId, Number(semester))
      const message = readiness.complete
        ? 'تم تفعيل زر بدء امتحان الفصل. جميع الاختبارات والواجبات الفصلية مكتملة.'
        : 'تم تفعيل زر بدء امتحان الفصل. الوحدات والواجبات الناقصة تظل متطلبات مستقلة ويُحتسب إنجازها في المجموع التراكمي دون خصم من الامتحان الفصلي.'
      return NextResponse.json({ ok: true, readiness, message })
    }
    if (!programId || !unitId) {
      return NextResponse.json({ error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    }

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'غير مسجل في البرنامج' }, { status: 403 })
    if (!['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      return NextResponse.json({ error: 'تسجيلك غير مفعّل — افتح بوابة الدفعات لاستكمال السداد أو اعتماد الإعفاء', code: 'ENROLLMENT_NOT_ACTIVE' }, { status: 403 })
    }

    // تحقق صارم: الوحدة يجب أن تنتمي فعلاً لهذا البرنامج (منع تجميع وحدات برامج أخرى)
    const unit = await db.unit.findFirst({ where: { id: unitId, programId }, select: { id: true } })
    if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لهذا البرنامج' }, { status: 400 })

    const completedUnits: string[] = JSON.parse(enrollment.completedUnits || '[]')
    if (!completedUnits.includes(unitId)) completedUnits.push(unitId)

    const totalUnits = await db.unit.count({ where: { programId } })

    // Marking a unit as read does not certify graduation or compute a final mark.
    // Those decisions belong solely to the weighted certificate eligibility service.
    const updated = await db.enrollment.update({
      where: { id: enrollment.id },
      data: { completedUnits: JSON.stringify(completedUnits) },
    })

    // Keep these counts for student guidance only: failed units/assignments cost
    // weighted points but are NOT stand-alone certificate blockers.
    let examsNotPassed = 0
    let assignmentsNotPassed = 0
    if (totalUnits > 0 && completedUnits.length >= totalUnits) {
      const gate = await getExamsGate(user.id, programId)
      examsNotPassed = gate.missing.filter((item) => item.kind === 'UNIT').length
      const requiredAssignments = await db.programAssignment.findMany({
        where: { programId, status: 'PUBLISHED' },
        select: { id: true, points: true, submissions: { where: { userId: user.id }, select: { score: true, status: true }, take: 1 } },
      })
      assignmentsNotPassed = requiredAssignments.filter((assignment) => {
        const submission = assignment.submissions[0]
        if (!submission || submission.status !== 'GRADED' || submission.score == null) return true
        return assignment.points > 0 ? (submission.score / assignment.points) * 100 < 60 : false
      }).length
    }

    // Opening the progress page registers or refreshes the graduation
    // transaction — it never issues a certificate. A certificate is shown
    // only when one was actually issued through administrative approval.
    const registration = await registerGraduationRequest({ enrollmentId: enrollment.id })
    await matureSemesterRaisesAfterGrading(db, { enrollmentId: enrollment.id })
    const certificate = registration?.certificateNo
      ? { serial: registration.certificateNo }
      : null

    return NextResponse.json({
      ok: true,
      completedUnits,
      progress: totalUnits ? Math.round((completedUnits.length / totalUnits) * 100) : 0,
      status: registration?.status === 'ISSUED' ? 'COMPLETED' : updated.status,
      finalScore: updated.finalScore,
      examsNotPassed,
      assignmentsNotPassed,
      certificate,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    if (e?.message === 'SEM1_REQUIRED') {
      return NextResponse.json({ error: 'يجب اجتياز امتحان الفصل الدراسي الأول قبل فتح الثاني', code: 'SEM1_REQUIRED' }, { status: 403 })
    }
    console.error('Progress POST error:', e)
    return NextResponse.json({ error: 'خطأ في تحديث التقدم' }, { status: 500 })
  }
}
