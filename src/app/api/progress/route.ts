import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { nextCertSerial } from '@/lib/settings'
import { notify } from '@/lib/notify'
import { getExamsGate } from '@/lib/exam-gate'
import { academicProfileFromRules } from '@/lib/program-tracks'
import { randomBytes } from 'crypto'

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
    if (enrollment.status === 'PENDING_PAYMENT') {
      return NextResponse.json(
        { error: 'تسجيلك بانتظار سداد الفاتورة — أكمل الدفع من تبويب «الدفعات» لتفعيل الوصول للمحتوى', code: 'PENDING_PAYMENT' },
        { status: 402 }
      )
    }

    const program = await db.program.findUnique({
      where: { id: programId },
      include: {
        units: {
          orderBy: { order: 'asc' },
          include: { exam: { select: { id: true, title: true, passScore: true } } },
        },
        books: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, titleEn: true, semester: true, source: true } },
        assignments: { where: { status: { not: 'ARCHIVED' } }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, points: true, status: true } },
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
    const bestByExam: Record<string, { score: number; passed: boolean }> = {}
    for (const a of attempts) {
      if (a.examId && !bestByExam[a.examId] && a.score !== null) {
        bestByExam[a.examId] = { score: a.score, passed: !!a.passed }
      }
    }

    const completedUnits: string[] = JSON.parse(enrollment.completedUnits || '[]')
    const totalUnits = program.units.length
    const progress = totalUnits ? Math.round((completedUnits.length / totalUnits) * 100) : 0

    // 12.2: امتحانا الفصلين المبنيان على الكتب المقررة + عدد الكتب
    const [readyExams, reviewCount, booksCount] = await Promise.all([
      db.programExam.findMany({
        where: { programId, status: 'READY' },
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
      }),
      db.programExam.count({ where: { programId, status: 'REVIEW' } }),
      db.book.count({ where: { programId } }),
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
        books: program.books,
        assignments: program.assignments,
        exams: program.programExams.map((e) => ({ id: e.id, title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
        academicProfile: academicProfileFromRules(program.admissionRules),
      },
      progress,
      status: enrollment.status,
      finalScore: enrollment.finalScore,
      completedUnits,
      booksCount,
      finalExam,
      pendingReviewExams: reviewCount,
      semesterExams,
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
    const { programId, unitId } = await req.json()
    if (!programId || !unitId) {
      return NextResponse.json({ error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    }

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'غير مسجل في البرنامج' }, { status: 403 })

    // تحقق صارم: الوحدة يجب أن تنتمي فعلاً لهذا البرنامج (منع تجميع وحدات برامج أخرى)
    const unit = await db.unit.findFirst({ where: { id: unitId, programId }, select: { id: true } })
    if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لهذا البرنامج' }, { status: 400 })

    const completedUnits: string[] = JSON.parse(enrollment.completedUnits || '[]')
    if (!completedUnits.includes(unitId)) completedUnits.push(unitId)

    const totalUnits = await db.unit.count({ where: { programId } })
    let status = totalUnits > 0 && completedUnits.length >= totalUnits ? 'COMPLETED' : 'ACTIVE'

    // لا إكمال للبرنامج قبل اجتياز جميع اختبارات وحداته وواجباته المنشورة (بوابة الجودة)
    let examsNotPassed = 0
    let assignmentsNotPassed = 0
    if (status === 'COMPLETED') {
      const gate = await getExamsGate(user.id, programId)
      const unitMissing = gate.missing.filter((m) => m.kind === 'UNIT')
      examsNotPassed = unitMissing.length
      const requiredAssignments = await db.programAssignment.findMany({
        where: { programId, status: 'PUBLISHED' },
        select: { id: true, points: true, submissions: { where: { userId: user.id }, select: { score: true, status: true }, take: 1 } },
      })
      assignmentsNotPassed = requiredAssignments.filter((a) => {
        const sub = a.submissions[0]
        if (!sub || sub.status !== 'GRADED' || sub.score == null) return true
        return a.points > 0 ? (sub.score / a.points) * 100 < 60 : false
      }).length
      if (examsNotPassed > 0 || assignmentsNotPassed > 0) {
        status = 'ACTIVE' // يبقى نشطاً حتى يجتاز كل الاختبارات والواجبات المنشورة
      }
    }

    // حساب النتيجة النهائية كمتوسط أفضل درجات الاختبارات
    let finalScore = enrollment.finalScore
    if (status === 'COMPLETED') {
      const units = await db.unit.findMany({
        where: { programId },
        include: { exam: { select: { id: true } } },
      })
      const examIds = units.map((u) => u.exam?.id).filter(Boolean) as string[]
      if (examIds.length) {
        const attempts = await db.examAttempt.findMany({
          where: { userId: user.id, examId: { in: examIds }, passed: true },
          orderBy: { score: 'desc' },
        })
        const best: Record<string, number> = {}
        for (const a of attempts) {
          if (a.examId && a.score !== null && (!best[a.examId] || a.score > best[a.examId])) {
            best[a.examId] = a.score
          }
        }
        const scores = examIds.map((id) => best[id]).filter((s) => s !== undefined)
        if (scores.length === examIds.length) {
          finalScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        }
      }
    }

    const updated = await db.enrollment.update({
      where: { id: enrollment.id },
      data: { completedUnits: JSON.stringify(completedUnits), status, finalScore },
    })

    // إصدار رقم الشهادة تلقائياً عند إكمال البرنامج (وفق اللوائح: خلال 30 يوماً)
    let certificate: { serial: string } | null = null
    if (status === 'COMPLETED' && !updated.certificateNo) {
      const program = await db.program.findUnique({ where: { id: programId } })
      const serial = await nextCertSerial()
      certificate = await db.certificate.create({
        data: {
          serial,
          qrToken: randomBytes(16).toString('hex'),
          type: 'PROGRAM_COMPLETION',
          holderName: user.name,
          program: program?.titleAr || 'برنامج تدريبي',
          grade: finalScore != null ? `${finalScore}%` : null,
          userId: user.id,
          enrollmentId: enrollment.id,
        },
      })
      await db.enrollment.update({
        where: { id: enrollment.id },
        data: { certificateNo: certificate.serial },
      })
      await notify(
        user.id,
        'CERTIFICATE',
        'تم إصدار شهادتك المعتمدة',
        `مبروك! أُصدرت شهادتك لبرنامج «${program?.titleAr}» برقم ${certificate.serial} — يمكنك تحميلها وطباعتها من بوابة الطالب.`,
        'dashboard'
      )
    }

    return NextResponse.json({
      ok: true,
      completedUnits: JSON.parse(updated.completedUnits),
      progress: totalUnits ? Math.round((completedUnits.length / totalUnits) * 100) : 0,
      status,
      finalScore,
      examsNotPassed,
      assignmentsNotPassed,
      certificate: certificate ? { serial: certificate.serial } : null,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Progress POST error:', e)
    return NextResponse.json({ error: 'خطأ في تحديث التقدم' }, { status: 500 })
  }
}
