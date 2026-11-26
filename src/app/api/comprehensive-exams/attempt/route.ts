import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  buildComprehensiveAttemptDisplay,
  buildComprehensiveAttemptSnapshot,
  ComprehensiveExamPhase2Error,
  gradeComprehensiveAttempt,
  parseComprehensiveAttemptSnapshot,
  parseComprehensiveAttemptTerms,
  qualifyComprehensiveExamCandidate,
  tokensEqual,
} from '@/lib/comprehensive-exam-phase2'

export const runtime = 'nodejs'

function phase2ErrorResponse(e: unknown, fallback: string) {
  if (e instanceof ComprehensiveExamPhase2Error) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  console.error('comprehensive exam attempt error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function remainingSeconds(startedAt: Date, durationMin: number) {
  const elapsedMs = Date.now() - new Date(startedAt).getTime()
  return Math.max(0, Math.floor(durationMin * 60 - elapsedMs / 1000))
}

async function loadInvitationByToken(token: string) {
  const invitation = await db.comprehensiveExamInvitation.findUnique({
    where: { token },
    include: {
      candidate: {
        select: { id: true, userId: true, fullName: true, nationalId: true, email: true, phone: true, status: true, examId: true, reviewedById: true },
      },
    },
  })
  // Constant-time check even though the lookup already matched: the
  // presented token is only honoured when it equals the stored one.
  if (!invitation || !tokensEqual(token, invitation.token)) return null
  const exam = await db.comprehensiveExam.findUnique({
    where: { id: invitation.candidate.examId },
    select: { id: true, status: true, programId: true, specializationProgramId: true, title: true, durationMin: true, passScore: true },
  })
  if (!exam) return null
  const program = await db.program.findUnique({
    where: { id: exam.programId },
    select: { id: true, titleAr: true, titleEn: true },
  })
  const specialization = exam.specializationProgramId
    ? await db.program.findUnique({
        where: { id: exam.specializationProgramId },
        select: { id: true, titleAr: true, titleEn: true },
      })
    : null
  return { invitation, candidate: invitation.candidate, exam, program, specialization }
}

// GET /api/comprehensive-exams/attempt?token=… — بدء محاولة أو استئنافها.
// الرابط وحده يفتح الامتحان؛ الأسئلة تُرسَل بالترتيب المخلط لهذه
// المحاولة فقط، ومن غير الإجابة الصحيحة أبداً.
export async function GET(req: NextRequest) {
  try {
    const token = String(req.nextUrl.searchParams.get('token') || '').trim()
    if (!token) return NextResponse.json({ error: 'رابط الدعوة ناقص' }, { status: 400 })
    const loaded = await loadInvitationByToken(token)
    if (!loaded) return NextResponse.json({ error: 'رابط الدعوة غير صحيح أو منتهي', code: 'INVALID_TOKEN' }, { status: 404 })
    const { invitation, candidate, exam, program, specialization } = loaded
    // ما يراه الطالب هو التخصص الذي يعادله، لا برنامج المعادلة نفسه.
    const programTitle = String(specialization?.titleAr || specialization?.titleEn || program?.titleAr || program?.titleEn || exam.title)

    if (invitation.status === 'REVOKED') {
      return NextResponse.json({ error: 'هذه الدعوة ملغاة — تواصل مع الإدارة', code: 'INVITATION_REVOKED' }, { status: 410 })
    }

    if (invitation.status === 'USED') {
      const attempt = await db.comprehensiveExamAttempt.findUnique({ where: { invitationId: invitation.id } })
      if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة', code: 'ATTEMPT_NOT_FOUND' }, { status: 404 })
      if (attempt.status === 'GRADED') {
        const certificate = await db.certificate.findFirst({
          where: { type: 'COMPREHENSIVE_EXAM', comprehensiveExamId: exam.id, user: { email: candidate.email } },
          select: { id: true, serial: true, qrToken: true },
        })
        return NextResponse.json({
          status: 'GRADED',
          attemptId: attempt.id,
          score: attempt.score,
          passed: attempt.passed,
          certificateSerial: certificate?.serial || null,
          certificateQrToken: certificate?.qrToken || null,
          examTitle: exam.title,
          programTitle,
        })
      }
      if (attempt.status === 'EXPIRED') {
        return NextResponse.json({ error: 'انتهى وقت الامتحان', code: 'ATTEMPT_EXPIRED' }, { status: 410 })
      }
      // STARTED — use terms frozen at the moment this attempt began.
      const terms = parseComprehensiveAttemptTerms(attempt.questionSnapshot, exam)
      const left = remainingSeconds(attempt.startedAt, terms.durationMin)
      if (left <= 0) {
        await db.comprehensiveExamAttempt.update({ where: { id: attempt.id }, data: { status: 'EXPIRED' } })
        return NextResponse.json({ error: 'انتهى وقت الامتحان', code: 'ATTEMPT_EXPIRED' }, { status: 410 })
      }
      const snapshot = parseComprehensiveAttemptSnapshot(attempt.questionSnapshot)
      const display = buildComprehensiveAttemptDisplay(attempt.id, snapshot)
      return NextResponse.json({
        status: 'RESUMED',
        attemptId: attempt.id,
        questions: display,
        remainingSeconds: left,
        durationMin: terms.durationMin,
        passScore: terms.passScore,
        examTitle: exam.title,
        programTitle,
      })
    }

    // PENDING — start a fresh attempt.
    if (invitation.status !== 'PENDING') {
      return NextResponse.json({ error: 'هذه الدعوة غير صالحة', code: 'INVITATION_INVALID' }, { status: 410 })
    }
    if (Date.now() > new Date(invitation.expiresAt).getTime()) {
      await db.comprehensiveExamInvitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } })
      return NextResponse.json({ error: 'انتهت صلاحية الدعوة — تواصل مع الإدارة لتجديدها', code: 'INVITATION_EXPIRED' }, { status: 410 })
    }
    if (exam.status !== 'READY') {
      return NextResponse.json({ error: 'الامتحان غير متاح حالياً — تواصل مع الإدارة' }, { status: 409 })
    }
    const questions = await db.comprehensiveExamQuestion.findMany({
      where: { examId: exam.id, status: 'APPROVED' },
      orderBy: { order: 'asc' },
      // correctAnswer AND order MUST be selected: the snapshot builder
      // drops questions without a key and loses order without it, so
      // omitting either would start an empty or mis-ordered exam.
      select: { id: true, order: true, type: true, text: true, options: true, correctAnswer: true },
    })
    if (questions.length === 0) {
      return NextResponse.json({ error: 'الامتحان غير مكتمل — تواصل مع الإدارة' }, { status: 500 })
    }
    const attemptId = randomUUID()
    const snapshot = buildComprehensiveAttemptSnapshot(questions as any)
    const display = buildComprehensiveAttemptDisplay(attemptId, snapshot)
    await db.$transaction(async (tx) => {
      await tx.comprehensiveExamAttempt.create({
        data: {
          id: attemptId,
          invitationId: invitation.id,
          candidateId: candidate.id,
          examId: exam.id,
          questionSnapshot: JSON.stringify({ questions: snapshot, durationMin: exam.durationMin, passScore: exam.passScore }),
          status: 'STARTED',
          startedAt: new Date(),
        },
      })
      await tx.comprehensiveExamInvitation.update({
        where: { id: invitation.id },
        data: { status: 'USED' },
      })
    })
    return NextResponse.json({
      status: 'STARTED',
      attemptId,
      questions: display,
      remainingSeconds: exam.durationMin * 60,
      durationMin: exam.durationMin,
      passScore: exam.passScore,
      examTitle: exam.title,
      programTitle,
    })
  } catch (e) {
    return phase2ErrorResponse(e, 'تعذر بدء الامتحان')
  }
}

// POST /api/comprehensive-exams/attempt — تسليم المحاولة مرة واحدة.
// يصحح من لقطة المحاولة، ويحفظ الإجابات والنتيجة، وإن نجح المرشح
// يؤهله (مستخدم + تسجيل مكتمل + شهادة) في معاملة ثانية؛ إن توقف
// التأهيل على تكرار، تبقى النتيجة ناجحة ويعيد المدير التأهيل من التبويب.
export async function POST(req: NextRequest) {
  try {
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const token = String(body?.token || '').trim()
    if (!token) return NextResponse.json({ error: 'رابط الدعوة ناقص' }, { status: 400 })
    const loaded = await loadInvitationByToken(token)
    if (!loaded) return NextResponse.json({ error: 'رابط الدعوة غير صحيح أو منتهي', code: 'INVALID_TOKEN' }, { status: 404 })
    const { invitation, candidate, exam, program, specialization } = loaded
    if (invitation.status === 'REVOKED') {
      return NextResponse.json({ error: 'هذه الدعوة ملغاة — تواصل مع الإدارة', code: 'INVITATION_REVOKED' }, { status: 410 })
    }
    if (invitation.status === 'PENDING') {
      return NextResponse.json({ error: 'افتح رابط الدعوة أولاً لبدء الامتحان' }, { status: 409 })
    }
    const attempt = await db.comprehensiveExamAttempt.findUnique({ where: { invitationId: invitation.id } })
    if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة', code: 'ATTEMPT_NOT_FOUND' }, { status: 404 })
    if (attempt.status === 'GRADED') {
      return NextResponse.json({ error: 'أُرسل هذا الامتحان سابقاً — لا يمكن إرساله مرة ثانية', code: 'ALREADY_SUBMITTED', score: attempt.score, passed: attempt.passed }, { status: 409 })
    }
    if (attempt.status === 'EXPIRED') {
      return NextResponse.json({ error: 'انتهى وقت الامتحان', code: 'ATTEMPT_EXPIRED' }, { status: 410 })
    }
    const terms = parseComprehensiveAttemptTerms(attempt.questionSnapshot, exam)
    const left = remainingSeconds(attempt.startedAt, terms.durationMin)
    if (left <= 0) {
      await db.comprehensiveExamAttempt.update({ where: { id: attempt.id }, data: { status: 'EXPIRED' } })
      return NextResponse.json({ error: 'انتهى وقت الامتحان قبل الإرسال', code: 'ATTEMPT_EXPIRED' }, { status: 410 })
    }
    const rawAnswers = Array.isArray(body?.answers) ? body.answers : []
    const answers = rawAnswers.map((a: any) => ({
      questionId: String(a?.questionId || ''),
      selectedOption: Number.isInteger(a?.selectedOption) ? a.selectedOption : null,
    }))
    const snapshot = parseComprehensiveAttemptSnapshot(attempt.questionSnapshot)
    const display = buildComprehensiveAttemptDisplay(attempt.id, snapshot)
    const graded = gradeComprehensiveAttempt({
      attemptId: attempt.id,
      snapshot,
      display,
      answers,
      passScore: exam.passScore,
    })
    const submittedAt = new Date()
    const durationUsedMin = Math.max(
      0,
      Math.min(exam.durationMin, Math.floor((submittedAt.getTime() - new Date(attempt.startedAt).getTime()) / 60000)),
    )
    await db.$transaction(async (tx) => {
      await tx.comprehensiveExamAnswer.deleteMany({ where: { attemptId: attempt.id } })
      await tx.comprehensiveExamAnswer.createMany({
        data: graded.perQuestion.map((a) => ({
          attemptId: attempt.id,
          questionId: a.questionId,
          selectedOption: a.selectedOption,
          isCorrect: a.isCorrect,
          points: a.points,
        })),
      })
      await tx.comprehensiveExamAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'GRADED',
          submittedAt,
          durationUsedMin,
          score: graded.score,
          passed: graded.passed,
        },
      })
    })

    let qualified = false
    let certificateSerial: string | null = null
    let qualificationError: string | null = null
    if (graded.passed && program && specialization) {
      try {
        const result = await db.$transaction(async (tx) =>
          qualifyComprehensiveExamCandidate(tx, {
            candidate: { id: candidate.id, userId: candidate.userId, fullName: candidate.fullName, nationalId: candidate.nationalId, email: candidate.email, phone: candidate.phone },
            exam: { id: exam.id, programId: exam.programId },
            program: { id: program.id, titleAr: program.titleAr, titleEn: program.titleEn },
            specialization: { id: specialization.id, titleAr: specialization.titleAr, titleEn: specialization.titleEn },
            attempt: { id: attempt.id, score: graded.score },
            admin: { id: candidate.reviewedById || null, name: 'النظام' },
          }),
        )
        qualified = true
        certificateSerial = result.certificate.serial
      } catch (e: any) {
        qualificationError =
          e instanceof ComprehensiveExamPhase2Error
            ? e.message
            : 'تعذر إصدار الشهادة — راجع الإدارة'
      }
    } else if (graded.passed) {
      qualificationError = 'الامتحان بلا تخصص — تواصل مع الإدارة لإكمال التأهيل'
    }
    return NextResponse.json({
      ok: true,
      score: graded.score,
      passed: graded.passed,
      totalPoints: graded.totalPoints,
      earnedPoints: graded.earnedPoints,
      qualified,
      certificateSerial,
      qualificationError,
    })
  } catch (e) {
    return phase2ErrorResponse(e, 'تعذر تسليم الامتحان')
  }
}
