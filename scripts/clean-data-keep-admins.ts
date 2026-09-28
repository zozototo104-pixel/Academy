import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type CleanupProfile = 'qa-only' | 'launch' | 'factory'
type CountResult = { count: number }
type Step = {
  key: string
  label: string
  count: number
  execute: () => Promise<CountResult>
}

const QA_ONLY_CONFIRMATION = 'DELETE_QA_ONLY'
const DATA_CLEANUP_CONFIRMATION = 'KEEP_ADMINS_CLEAN_DATABASE'
const FULL_RESET_CONFIRMATION = 'DELETE_ALL_NON_ADMINS_AND_REAL_DATA'
const FACTORY_CONFIRMATION = 'DELETE_CONTENT_TOO'

function getArgValue(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim()
  const index = process.argv.indexOf(name)
  if (index >= 0) return String(process.argv[index + 1] || '').trim()
  return ''
}

function hasArg(name: string) {
  return process.argv.includes(name)
}

function resolveProfile(): CleanupProfile {
  const raw = (getArgValue('--profile') || 'launch').toLowerCase()
  if (raw === 'qa-only' || raw === 'qa') return 'qa-only'
  if (raw === 'factory') return 'factory'
  if (raw === 'launch') return 'launch'
  throw new Error(`Unknown cleanup profile "${raw}". Use --profile qa-only, --profile launch, or --profile factory.`)
}

async function countDelete(label: string, count: () => Promise<number>, execute: () => Promise<CountResult>): Promise<Step> {
  return {
    key: label,
    label,
    count: await count(),
    execute,
  }
}

function qaProgramWhere() {
  return {
    OR: [
      { slug: { startsWith: 'qa-full-journey-' } },
      { slug: 'launch-quality-diagnostic-program' },
      { titleAr: { contains: 'رحلة كاملة QA' } },
      { titleAr: { contains: 'جودة رحلة كاملة QA' } },
      { titleEn: { contains: 'QA Full Journey' } },
      { titleEn: { contains: 'Launch Quality Diagnostic Program' } },
    ],
  }
}

function qaUserWhere() {
  return {
    role: { not: 'ADMIN' },
    OR: [
      { email: { endsWith: '@aact.test' } },
      { email: 'launch.quality.student@aact.test' },
      { name: { contains: 'رحلة كاملة QA' } },
      { name: { contains: 'Launch Quality' } },
    ],
  }
}

function noneWhere(field = 'id') {
  return { [field]: '__none__' } as any
}

function idIn(ids: string[], field = 'id') {
  return ids.length ? ({ [field]: { in: ids } } as any) : noneWhere(field)
}

function orWhere(clauses: any[], fallbackField = 'id') {
  const clean = clauses.filter(Boolean)
  return clean.length ? ({ OR: clean } as any) : noneWhere(fallbackField)
}

async function buildQaOnlySteps(): Promise<Step[]> {
  const steps: Step[] = []
  const qaUsers = await prisma.user.findMany({ where: qaUserWhere() as any, select: { id: true, email: true } })
  const qaUserIds = qaUsers.map((user) => user.id)
  const qaPrograms = await prisma.program.findMany({ where: qaProgramWhere(), select: { id: true, slug: true } })
  const qaProgramIds = qaPrograms.map((program) => program.id)

  if (!qaUserIds.length && !qaProgramIds.length) return steps

  const qaProgramIdWhere = idIn(qaProgramIds, 'programId')
  const qaUserIdWhere = idIn(qaUserIds, 'userId')

  const admissionOr = [
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
    { email: { endsWith: '@aact.test' } },
    qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined,
    { reference: 'AACT-LAUNCH-QUALITY' },
    { notes: { contains: 'QA_FULL_JOURNEY' } },
    { program: { contains: 'QA خدمة مهنية' } },
  ].filter(Boolean) as any[]
  const qaAdmissionWhere = admissionOr.length ? { OR: admissionOr } : noneWhere()
  const qaAdmissions = await prisma.admissionApplication.findMany({ where: qaAdmissionWhere, select: { id: true } })
  const qaAdmissionIds = qaAdmissions.map((admission) => admission.id)

  const enrollmentOr = [
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
    qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined,
  ].filter(Boolean) as any[]
  const qaEnrollmentWhere = enrollmentOr.length ? { OR: enrollmentOr } : noneWhere()
  const qaEnrollments = await prisma.enrollment.findMany({ where: qaEnrollmentWhere, select: { id: true } })
  const qaEnrollmentIds = qaEnrollments.map((enrollment) => enrollment.id)

  const paymentOr = [
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
    qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined,
    qaEnrollmentIds.length ? { enrollmentId: { in: qaEnrollmentIds } } : undefined,
    { payerEmail: { endsWith: '@aact.test' } },
    { description: { contains: 'QA' } },
  ].filter(Boolean) as any[]
  const qaPaymentWhere = paymentOr.length ? { OR: paymentOr } : noneWhere()
  const qaPayments = await prisma.payment.findMany({ where: qaPaymentWhere, select: { id: true } })
  const qaPaymentIds = qaPayments.map((payment) => payment.id)

  const thesisOr = [
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
    qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined,
    { title: { contains: 'QA' } },
  ].filter(Boolean) as any[]
  const qaThesisWhere = thesisOr.length ? { OR: thesisOr } : noneWhere()
  const qaTheses = await prisma.thesisSubmission.findMany({ where: qaThesisWhere, select: { id: true } })
  const qaThesisIds = qaTheses.map((thesis) => thesis.id)

  const qaSupervisorAssessmentWhere = [
    qaUserIds.length ? { studentId: { in: qaUserIds } } : undefined,
    qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined,
    qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined,
    { title: { contains: 'QA' } },
  ].filter(Boolean) as any[]
  const assessmentWhere = qaSupervisorAssessmentWhere.length ? { OR: qaSupervisorAssessmentWhere } : noneWhere()
  const qaAssessments = await prisma.supervisorAssessment.findMany({ where: assessmentWhere, select: { id: true } })
  const qaAssessmentIds = qaAssessments.map((assessment) => assessment.id)
  const qaAssessmentAttemptWhere = orWhere([
    qaAssessmentIds.length ? { assessmentId: { in: qaAssessmentIds } } : undefined,
    qaUserIds.length ? { studentId: { in: qaUserIds } } : undefined,
  ])
  const qaAssessmentAttempts = await prisma.supervisorAssessmentAttempt.findMany({
    where: qaAssessmentAttemptWhere,
    select: { id: true },
  })
  const qaAssessmentAttemptIds = qaAssessmentAttempts.map((attempt) => attempt.id)
  const qaVoiceCallWhere = orWhere([
    qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined,
    qaUserIds.length ? { studentId: { in: qaUserIds } } : undefined,
    qaUserIds.length ? { initiatorId: { in: qaUserIds } } : undefined,
  ])
  const qaVoiceCalls = await prisma.supervisorVoiceCall.findMany({
    where: qaVoiceCallWhere,
    select: { id: true },
  })
  const qaVoiceCallIds = qaVoiceCalls.map((call) => call.id)

  const qaSupervisorAssessmentAnswerWhere = orWhere([
    qaAssessmentAttemptIds.length ? { attemptId: { in: qaAssessmentAttemptIds } } : undefined,
    qaAssessmentIds.length ? { question: { assessmentId: { in: qaAssessmentIds } } } : undefined,
  ])

  steps.push(await countDelete('QA supervisor assessment answers', () => prisma.supervisorAssessmentAnswer.count({ where: qaSupervisorAssessmentAnswerWhere }), () => prisma.supervisorAssessmentAnswer.deleteMany({ where: qaSupervisorAssessmentAnswerWhere })))
  steps.push(await countDelete('QA supervisor assessment attempts', () => prisma.supervisorAssessmentAttempt.count({ where: qaAssessmentAttemptWhere }), () => prisma.supervisorAssessmentAttempt.deleteMany({ where: qaAssessmentAttemptWhere })))
  steps.push(await countDelete('QA supervisor assessment questions', () => prisma.supervisorAssessmentQuestion.count({ where: qaAssessmentIds.length ? { assessmentId: { in: qaAssessmentIds } } : noneWhere('assessmentId') }), () => prisma.supervisorAssessmentQuestion.deleteMany({ where: qaAssessmentIds.length ? { assessmentId: { in: qaAssessmentIds } } : noneWhere('assessmentId') })))
  steps.push(await countDelete('QA supervisor assessments', () => prisma.supervisorAssessment.count({ where: assessmentWhere }), () => prisma.supervisorAssessment.deleteMany({ where: assessmentWhere })))

  const qaSupervisorChannelMessageWhere = orWhere([
    qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined,
    qaUserIds.length ? { studentId: { in: qaUserIds } } : undefined,
    qaUserIds.length ? { senderId: { in: qaUserIds } } : undefined,
  ])
  const qaDefenseParticipantWhere = orWhere([
    qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : undefined,
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
  ])

  steps.push(await countDelete('QA supervisor voice signals', () => prisma.supervisorVoiceSignal.count({ where: qaVoiceCallIds.length ? { callId: { in: qaVoiceCallIds } } : noneWhere('callId') }), () => prisma.supervisorVoiceSignal.deleteMany({ where: qaVoiceCallIds.length ? { callId: { in: qaVoiceCallIds } } : noneWhere('callId') })))
  steps.push(await countDelete('QA supervisor voice calls', () => prisma.supervisorVoiceCall.count({ where: qaVoiceCallIds.length ? { id: { in: qaVoiceCallIds } } : noneWhere() }), () => prisma.supervisorVoiceCall.deleteMany({ where: qaVoiceCallIds.length ? { id: { in: qaVoiceCallIds } } : noneWhere() })))
  steps.push(await countDelete('QA supervisor channel messages', () => prisma.supervisorChannelMessage.count({ where: qaSupervisorChannelMessageWhere }), () => prisma.supervisorChannelMessage.deleteMany({ where: qaSupervisorChannelMessageWhere })))

  steps.push(await countDelete('QA defense signals', () => prisma.defenseSignal.count({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') }), () => prisma.defenseSignal.deleteMany({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') })))
  steps.push(await countDelete('QA defense participants', () => prisma.defenseParticipant.count({ where: qaDefenseParticipantWhere }), () => prisma.defenseParticipant.deleteMany({ where: qaDefenseParticipantWhere })))
  steps.push(await countDelete('QA defense messages', () => prisma.defenseMessage.count({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') }), () => prisma.defenseMessage.deleteMany({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') })))

  steps.push(await countDelete('QA program answers', () => prisma.programAnswer.count({ where: { OR: [qaUserIds.length ? { attempt: { userId: { in: qaUserIds } } } : undefined, qaProgramIds.length ? { question: { exam: { programId: { in: qaProgramIds } } } } : undefined].filter(Boolean) as any[] } }), () => prisma.programAnswer.deleteMany({ where: { OR: [qaUserIds.length ? { attempt: { userId: { in: qaUserIds } } } : undefined, qaProgramIds.length ? { question: { exam: { programId: { in: qaProgramIds } } } } : undefined].filter(Boolean) as any[] } })))
  const qaProgramExamAttemptWhere = orWhere([
    qaUserIds.length ? { userId: { in: qaUserIds } } : undefined,
    qaProgramIds.length ? { exam: { programId: { in: qaProgramIds } } } : undefined,
  ])
  steps.push(await countDelete('QA program exam attempts', () => prisma.programExamAttempt.count({ where: qaProgramExamAttemptWhere }), () => prisma.programExamAttempt.deleteMany({ where: qaProgramExamAttemptWhere })))
  steps.push(await countDelete('QA assignment submissions', () => prisma.assignmentSubmission.count({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { assignment: { programId: { in: qaProgramIds } } } : undefined].filter(Boolean) as any[] } }), () => prisma.assignmentSubmission.deleteMany({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { assignment: { programId: { in: qaProgramIds } } } : undefined].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA unit exam answers', () => prisma.answer.count({ where: { OR: [qaUserIds.length ? { attempt: { userId: { in: qaUserIds } } } : undefined, qaProgramIds.length ? { question: { exam: { unit: { programId: { in: qaProgramIds } } } } } : undefined].filter(Boolean) as any[] } }), () => prisma.answer.deleteMany({ where: { OR: [qaUserIds.length ? { attempt: { userId: { in: qaUserIds } } } : undefined, qaProgramIds.length ? { question: { exam: { unit: { programId: { in: qaProgramIds } } } } } : undefined].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA unit exam attempts', () => prisma.examAttempt.count({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { exam: { unit: { programId: { in: qaProgramIds } } } } : undefined].filter(Boolean) as any[] } }), () => prisma.examAttempt.deleteMany({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { exam: { unit: { programId: { in: qaProgramIds } } } } : undefined].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA exam drafts', () => prisma.examDraft.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.examDraft.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))

  steps.push(await countDelete('QA thesis review notes', () => prisma.thesisReviewNote.count({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') }), () => prisma.thesisReviewNote.deleteMany({ where: qaThesisIds.length ? { thesisId: { in: qaThesisIds } } : noneWhere('thesisId') })))
  steps.push(await countDelete('QA thesis submissions', () => prisma.thesisSubmission.count({ where: qaThesisWhere }), () => prisma.thesisSubmission.deleteMany({ where: qaThesisWhere })))
  steps.push(await countDelete('QA thesis topic requests', () => prisma.thesisTopicRequest.count({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined].filter(Boolean) as any[] } }), () => prisma.thesisTopicRequest.deleteMany({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined].filter(Boolean) as any[] } })))

  steps.push(await countDelete('QA service deliverables', () => prisma.serviceDeliverable.count({ where: qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : noneWhere('admissionId') }), () => prisma.serviceDeliverable.deleteMany({ where: qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : noneWhere('admissionId') })))
  steps.push(await countDelete('QA admission documents', () => prisma.admissionDocument.count({ where: qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : noneWhere('admissionId') }), () => prisma.admissionDocument.deleteMany({ where: qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : noneWhere('admissionId') })))
  steps.push(await countDelete('QA tuition installment appeals', () => prisma.tuitionInstallmentAppeal.count({ where: { OR: [qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined, qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined, qaEnrollmentIds.length ? { enrollmentId: { in: qaEnrollmentIds } } : undefined].filter(Boolean) as any[] } }), () => prisma.tuitionInstallmentAppeal.deleteMany({ where: { OR: [qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined, qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { programId: { in: qaProgramIds } } : undefined, qaEnrollmentIds.length ? { enrollmentId: { in: qaEnrollmentIds } } : undefined].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA certificates', () => prisma.certificate.count({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined, qaEnrollmentIds.length ? { enrollmentId: { in: qaEnrollmentIds } } : undefined, { program: { contains: 'QA' } }, { holderName: { contains: 'QA' } }].filter(Boolean) as any[] } }), () => prisma.certificate.deleteMany({ where: { OR: [qaUserIds.length ? { userId: { in: qaUserIds } } : undefined, qaAdmissionIds.length ? { admissionId: { in: qaAdmissionIds } } : undefined, qaEnrollmentIds.length ? { enrollmentId: { in: qaEnrollmentIds } } : undefined, { program: { contains: 'QA' } }, { holderName: { contains: 'QA' } }].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA payments', () => prisma.payment.count({ where: qaPaymentWhere }), () => prisma.payment.deleteMany({ where: qaPaymentWhere })))
  steps.push(await countDelete('QA admissions', () => prisma.admissionApplication.count({ where: qaAdmissionWhere }), () => prisma.admissionApplication.deleteMany({ where: qaAdmissionWhere })))
  steps.push(await countDelete('QA enrollments', () => prisma.enrollment.count({ where: qaEnrollmentWhere }), () => prisma.enrollment.deleteMany({ where: qaEnrollmentWhere })))

  steps.push(await countDelete('QA chat feedback', () => prisma.chatFeedback.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.chatFeedback.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA chat messages', () => prisma.chatMessage.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.chatMessage.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA student academic memory', () => prisma.studentAcademicMemory.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.studentAcademicMemory.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA notifications', () => prisma.notification.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.notification.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA user micro-credentials', () => prisma.userMicroCredential.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.userMicroCredential.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA AI live usage', () => prisma.aiLiveUsage.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.aiLiveUsage.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))
  steps.push(await countDelete('QA AI live credits', () => prisma.aiLiveCredit.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.aiLiveCredit.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))

  steps.push(await countDelete('QA contact messages', () => prisma.contactMessage.count({ where: { OR: [{ email: { endsWith: '@aact.test' } }, { subject: { contains: 'QA_FULL_JOURNEY_CONTACT' } }] } }), () => prisma.contactMessage.deleteMany({ where: { OR: [{ email: { endsWith: '@aact.test' } }, { subject: { contains: 'QA_FULL_JOURNEY_CONTACT' } }] } })))
  steps.push(await countDelete('QA email logs', () => prisma.emailLog.count({ where: { OR: [{ to: { endsWith: '@aact.test' } }, { subject: { contains: 'QA' } }, { event: { contains: 'QA' } }] } }), () => prisma.emailLog.deleteMany({ where: { OR: [{ to: { endsWith: '@aact.test' } }, { subject: { contains: 'QA' } }, { event: { contains: 'QA' } }] } })))
  steps.push(await countDelete('QA audit logs', () => prisma.auditLog.count({ where: { OR: [qaUserIds.length ? { actorId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { entityId: { in: qaProgramIds } } : undefined, qaAdmissionIds.length ? { entityId: { in: qaAdmissionIds } } : undefined, qaPaymentIds.length ? { entityId: { in: qaPaymentIds } } : undefined, { action: { contains: 'QA' } }, { details: { contains: 'QA' } }].filter(Boolean) as any[] } }), () => prisma.auditLog.deleteMany({ where: { OR: [qaUserIds.length ? { actorId: { in: qaUserIds } } : undefined, qaProgramIds.length ? { entityId: { in: qaProgramIds } } : undefined, qaAdmissionIds.length ? { entityId: { in: qaAdmissionIds } } : undefined, qaPaymentIds.length ? { entityId: { in: qaPaymentIds } } : undefined, { action: { contains: 'QA' } }, { details: { contains: 'QA' } }].filter(Boolean) as any[] } })))
  steps.push(await countDelete('QA sessions', () => prisma.session.count({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') }), () => prisma.session.deleteMany({ where: qaUserIds.length ? { userId: { in: qaUserIds } } : noneWhere('userId') })))

  steps.push(await countDelete('QA program questions', () => prisma.programQuestion.count({ where: { exam: qaProgramIdWhere } }), () => prisma.programQuestion.deleteMany({ where: { exam: qaProgramIdWhere } })))
  steps.push(await countDelete('QA program exams', () => prisma.programExam.count({ where: qaProgramIdWhere }), () => prisma.programExam.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA program assignments', () => prisma.programAssignment.count({ where: qaProgramIdWhere }), () => prisma.programAssignment.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA study guides', () => prisma.programStudyGuide.count({ where: qaProgramIdWhere }), () => prisma.programStudyGuide.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA question bank items', () => prisma.questionBankItem.count({ where: qaProgramIdWhere }), () => prisma.questionBankItem.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA knowledge items', () => prisma.bookKnowledgeItem.count({ where: qaProgramIdWhere }), () => prisma.bookKnowledgeItem.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA book upload chunks', () => prisma.bookUploadChunk.count({ where: { book: qaProgramIdWhere } }), () => prisma.bookUploadChunk.deleteMany({ where: { book: qaProgramIdWhere } })))
  steps.push(await countDelete('QA books', () => prisma.book.count({ where: qaProgramIdWhere }), () => prisma.book.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA unit questions', () => prisma.question.count({ where: { exam: { unit: qaProgramIdWhere } } }), () => prisma.question.deleteMany({ where: { exam: { unit: qaProgramIdWhere } } })))
  steps.push(await countDelete('QA unit exams', () => prisma.exam.count({ where: { unit: qaProgramIdWhere } }), () => prisma.exam.deleteMany({ where: { unit: qaProgramIdWhere } })))
  steps.push(await countDelete('QA units', () => prisma.unit.count({ where: qaProgramIdWhere }), () => prisma.unit.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA thesis topics', () => prisma.thesisTopic.count({ where: qaProgramIdWhere }), () => prisma.thesisTopic.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA micro-credentials', () => prisma.microCredential.count({ where: qaProgramIdWhere }), () => prisma.microCredential.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA programs', () => prisma.program.count({ where: qaProgramWhere() }), () => prisma.program.deleteMany({ where: qaProgramWhere() })))
  steps.push(await countDelete('QA users only', () => prisma.user.count({ where: qaUserWhere() as any }), () => prisma.user.deleteMany({ where: qaUserWhere() as any })))

  return steps
}

async function buildLaunchSteps(): Promise<Step[]> {
  const nonAdminUserWhere = { role: { not: 'ADMIN' } }
  const qaPrograms = await prisma.program.findMany({ where: qaProgramWhere(), select: { id: true } })
  const qaProgramIds = qaPrograms.map((program) => program.id)
  const qaProgramIdWhere = qaProgramIds.length ? { programId: { in: qaProgramIds } } : { programId: '__none__' }

  const steps: Step[] = []

  steps.push(await countDelete('Supervisor assessment answers', () => prisma.supervisorAssessmentAnswer.count(), () => prisma.supervisorAssessmentAnswer.deleteMany()))
  steps.push(await countDelete('Supervisor assessment attempts', () => prisma.supervisorAssessmentAttempt.count(), () => prisma.supervisorAssessmentAttempt.deleteMany()))
  steps.push(await countDelete('Supervisor assessment questions', () => prisma.supervisorAssessmentQuestion.count(), () => prisma.supervisorAssessmentQuestion.deleteMany()))
  steps.push(await countDelete('Supervisor assessments', () => prisma.supervisorAssessment.count(), () => prisma.supervisorAssessment.deleteMany()))

  steps.push(await countDelete('Supervisor voice signals', () => prisma.supervisorVoiceSignal.count(), () => prisma.supervisorVoiceSignal.deleteMany()))
  steps.push(await countDelete('Supervisor voice calls', () => prisma.supervisorVoiceCall.count(), () => prisma.supervisorVoiceCall.deleteMany()))
  steps.push(await countDelete('Supervisor channel messages', () => prisma.supervisorChannelMessage.count(), () => prisma.supervisorChannelMessage.deleteMany()))

  steps.push(await countDelete('Defense signals', () => prisma.defenseSignal.count(), () => prisma.defenseSignal.deleteMany()))
  steps.push(await countDelete('Defense participants', () => prisma.defenseParticipant.count(), () => prisma.defenseParticipant.deleteMany()))
  steps.push(await countDelete('Defense messages', () => prisma.defenseMessage.count(), () => prisma.defenseMessage.deleteMany()))

  steps.push(await countDelete('Program answers', () => prisma.programAnswer.count(), () => prisma.programAnswer.deleteMany()))
  steps.push(await countDelete('Program exam attempts', () => prisma.programExamAttempt.count(), () => prisma.programExamAttempt.deleteMany()))
  steps.push(await countDelete('Assignment submissions', () => prisma.assignmentSubmission.count(), () => prisma.assignmentSubmission.deleteMany()))
  steps.push(await countDelete('Unit exam answers', () => prisma.answer.count(), () => prisma.answer.deleteMany()))
  steps.push(await countDelete('Unit exam attempts', () => prisma.examAttempt.count(), () => prisma.examAttempt.deleteMany()))
  steps.push(await countDelete('Exam drafts', () => prisma.examDraft.count(), () => prisma.examDraft.deleteMany()))

  steps.push(await countDelete('Thesis review notes', () => prisma.thesisReviewNote.count(), () => prisma.thesisReviewNote.deleteMany()))
  steps.push(await countDelete('Thesis submissions', () => prisma.thesisSubmission.count(), () => prisma.thesisSubmission.deleteMany()))
  steps.push(await countDelete('Thesis topic requests', () => prisma.thesisTopicRequest.count(), () => prisma.thesisTopicRequest.deleteMany()))

  steps.push(await countDelete('Service deliverables', () => prisma.serviceDeliverable.count(), () => prisma.serviceDeliverable.deleteMany()))
  steps.push(await countDelete('Admission documents', () => prisma.admissionDocument.count(), () => prisma.admissionDocument.deleteMany()))
  steps.push(await countDelete('Tuition installment appeals', () => prisma.tuitionInstallmentAppeal.count(), () => prisma.tuitionInstallmentAppeal.deleteMany()))
  steps.push(await countDelete('Certificates', () => prisma.certificate.count(), () => prisma.certificate.deleteMany()))
  steps.push(await countDelete('Payments', () => prisma.payment.count(), () => prisma.payment.deleteMany()))
  steps.push(await countDelete('Admissions', () => prisma.admissionApplication.count(), () => prisma.admissionApplication.deleteMany()))
  steps.push(await countDelete('Enrollments', () => prisma.enrollment.count(), () => prisma.enrollment.deleteMany()))

  steps.push(await countDelete('Agent documents', () => prisma.agentDocument.count(), () => prisma.agentDocument.deleteMany()))
  steps.push(await countDelete('Revenue share transactions', () => prisma.revenueShareTransaction.count(), () => prisma.revenueShareTransaction.deleteMany()))
  steps.push(await countDelete('Agent applications', () => prisma.agentApplication.count(), () => prisma.agentApplication.deleteMany()))

  steps.push(await countDelete('Chat feedback', () => prisma.chatFeedback.count(), () => prisma.chatFeedback.deleteMany()))
  steps.push(await countDelete('Chat messages', () => prisma.chatMessage.count(), () => prisma.chatMessage.deleteMany()))
  steps.push(await countDelete('Student academic memory', () => prisma.studentAcademicMemory.count(), () => prisma.studentAcademicMemory.deleteMany()))
  steps.push(await countDelete('Notifications', () => prisma.notification.count(), () => prisma.notification.deleteMany()))
  steps.push(await countDelete('User micro-credentials', () => prisma.userMicroCredential.count(), () => prisma.userMicroCredential.deleteMany()))
  steps.push(await countDelete('AI live usage for non-admins', () => prisma.aiLiveUsage.count({ where: { user: nonAdminUserWhere } }), () => prisma.aiLiveUsage.deleteMany({ where: { user: nonAdminUserWhere } })))
  steps.push(await countDelete('AI live credits for non-admins', () => prisma.aiLiveCredit.count({ where: { user: nonAdminUserWhere } }), () => prisma.aiLiveCredit.deleteMany({ where: { user: nonAdminUserWhere } })))

  steps.push(await countDelete('Contact messages', () => prisma.contactMessage.count(), () => prisma.contactMessage.deleteMany()))
  steps.push(await countDelete('Email logs', () => prisma.emailLog.count(), () => prisma.emailLog.deleteMany()))
  steps.push(await countDelete('Audit logs', () => prisma.auditLog.count(), () => prisma.auditLog.deleteMany()))
  steps.push(await countDelete('Non-admin sessions', () => prisma.session.count({ where: { user: nonAdminUserWhere } }), () => prisma.session.deleteMany({ where: { user: nonAdminUserWhere } })))

  steps.push(await countDelete('QA program answers', () => prisma.programAnswer.count({ where: { question: { exam: qaProgramIdWhere } } }), () => prisma.programAnswer.deleteMany({ where: { question: { exam: qaProgramIdWhere } } })))
  steps.push(await countDelete('QA program questions', () => prisma.programQuestion.count({ where: { exam: qaProgramIdWhere } }), () => prisma.programQuestion.deleteMany({ where: { exam: qaProgramIdWhere } })))
  steps.push(await countDelete('QA program exams', () => prisma.programExam.count({ where: qaProgramIdWhere }), () => prisma.programExam.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA assignment submissions', () => prisma.assignmentSubmission.count({ where: { assignment: qaProgramIdWhere } }), () => prisma.assignmentSubmission.deleteMany({ where: { assignment: qaProgramIdWhere } })))
  steps.push(await countDelete('QA program assignments', () => prisma.programAssignment.count({ where: qaProgramIdWhere }), () => prisma.programAssignment.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA study guides', () => prisma.programStudyGuide.count({ where: qaProgramIdWhere }), () => prisma.programStudyGuide.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA question bank items', () => prisma.questionBankItem.count({ where: qaProgramIdWhere }), () => prisma.questionBankItem.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA knowledge items', () => prisma.bookKnowledgeItem.count({ where: qaProgramIdWhere }), () => prisma.bookKnowledgeItem.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA book upload chunks', () => prisma.bookUploadChunk.count({ where: { book: qaProgramIdWhere } }), () => prisma.bookUploadChunk.deleteMany({ where: { book: qaProgramIdWhere } })))
  steps.push(await countDelete('QA books', () => prisma.book.count({ where: qaProgramIdWhere }), () => prisma.book.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA unit answers', () => prisma.answer.count({ where: { question: { exam: { unit: qaProgramIdWhere } } } }), () => prisma.answer.deleteMany({ where: { question: { exam: { unit: qaProgramIdWhere } } } })))
  steps.push(await countDelete('QA unit questions', () => prisma.question.count({ where: { exam: { unit: qaProgramIdWhere } } }), () => prisma.question.deleteMany({ where: { exam: { unit: qaProgramIdWhere } } })))
  steps.push(await countDelete('QA unit exams', () => prisma.exam.count({ where: { unit: qaProgramIdWhere } }), () => prisma.exam.deleteMany({ where: { unit: qaProgramIdWhere } })))
  steps.push(await countDelete('QA units', () => prisma.unit.count({ where: qaProgramIdWhere }), () => prisma.unit.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA thesis topics', () => prisma.thesisTopic.count({ where: qaProgramIdWhere }), () => prisma.thesisTopic.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA micro-credentials', () => prisma.microCredential.count({ where: qaProgramIdWhere }), () => prisma.microCredential.deleteMany({ where: qaProgramIdWhere })))
  steps.push(await countDelete('QA programs', () => prisma.program.count({ where: qaProgramWhere() }), () => prisma.program.deleteMany({ where: qaProgramWhere() })))

  steps.push(await countDelete('Non-admin users', () => prisma.user.count({ where: nonAdminUserWhere }), () => prisma.user.deleteMany({ where: nonAdminUserWhere })))

  return steps
}

async function buildFactorySteps(): Promise<Step[]> {
  const steps = await buildLaunchSteps()

  steps.push(await countDelete('All program answers', () => prisma.programAnswer.count(), () => prisma.programAnswer.deleteMany()))
  steps.push(await countDelete('All program questions', () => prisma.programQuestion.count(), () => prisma.programQuestion.deleteMany()))
  steps.push(await countDelete('All program exams', () => prisma.programExam.count(), () => prisma.programExam.deleteMany()))
  steps.push(await countDelete('All assignment submissions', () => prisma.assignmentSubmission.count(), () => prisma.assignmentSubmission.deleteMany()))
  steps.push(await countDelete('All program assignments', () => prisma.programAssignment.count(), () => prisma.programAssignment.deleteMany()))
  steps.push(await countDelete('All study guides', () => prisma.programStudyGuide.count(), () => prisma.programStudyGuide.deleteMany()))
  steps.push(await countDelete('All question bank items', () => prisma.questionBankItem.count(), () => prisma.questionBankItem.deleteMany()))
  steps.push(await countDelete('All book knowledge items', () => prisma.bookKnowledgeItem.count(), () => prisma.bookKnowledgeItem.deleteMany()))
  steps.push(await countDelete('All book upload chunks', () => prisma.bookUploadChunk.count(), () => prisma.bookUploadChunk.deleteMany()))
  steps.push(await countDelete('All books', () => prisma.book.count(), () => prisma.book.deleteMany()))
  steps.push(await countDelete('All unit answers', () => prisma.answer.count(), () => prisma.answer.deleteMany()))
  steps.push(await countDelete('All unit questions', () => prisma.question.count(), () => prisma.question.deleteMany()))
  steps.push(await countDelete('All unit exams', () => prisma.exam.count(), () => prisma.exam.deleteMany()))
  steps.push(await countDelete('All units', () => prisma.unit.count(), () => prisma.unit.deleteMany()))
  steps.push(await countDelete('All thesis topics', () => prisma.thesisTopic.count(), () => prisma.thesisTopic.deleteMany()))
  steps.push(await countDelete('All micro-credentials', () => prisma.microCredential.count(), () => prisma.microCredential.deleteMany()))
  steps.push(await countDelete('All programs', () => prisma.program.count(), () => prisma.program.deleteMany()))

  return steps
}

async function main() {
  const profile = resolveProfile()
  const execute = hasArg('--execute')
  const startedAt = Date.now()
  const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } })

  if (adminCount < 1) {
    throw new Error('Refusing cleanup because no ADMIN user exists. Create or verify an admin first.')
  }

  if (execute && profile === 'qa-only' && process.env.AACT_CONFIRM_QA_ONLY_CLEANUP !== QA_ONLY_CONFIRMATION) {
    throw new Error(`Refusing QA-only cleanup. Set AACT_CONFIRM_QA_ONLY_CLEANUP=${QA_ONLY_CONFIRMATION} and run again.`)
  }

  if (execute && profile !== 'qa-only' && process.env.AACT_CONFIRM_DATA_CLEANUP !== DATA_CLEANUP_CONFIRMATION) {
    throw new Error(`Refusing destructive cleanup. Set AACT_CONFIRM_DATA_CLEANUP=${DATA_CLEANUP_CONFIRMATION} and run again.`)
  }

  if (execute && profile !== 'qa-only' && process.env.AACT_CONFIRM_FULL_RESET !== FULL_RESET_CONFIRMATION) {
    throw new Error(`This cleanup deletes every non-admin user and real operational data. Set AACT_CONFIRM_FULL_RESET=${FULL_RESET_CONFIRMATION} to allow it.`)
  }

  if (execute && profile === 'factory' && process.env.AACT_CONFIRM_FACTORY_RESET !== FACTORY_CONFIRMATION) {
    throw new Error(`Factory cleanup also deletes academic content. Set AACT_CONFIRM_FACTORY_RESET=${FACTORY_CONFIRMATION} to allow it.`)
  }

  const steps = profile === 'qa-only' ? await buildQaOnlySteps() : profile === 'factory' ? await buildFactorySteps() : await buildLaunchSteps()

  console.log(`AACT data cleanup profile: ${profile}`)
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`)
  console.log(`Admin users preserved: ${adminCount}`)
  console.log('---')

  const results: Record<string, number> = {}
  for (const step of steps) {
    const affected = execute ? (await step.execute()).count : step.count
    results[step.label] = affected
    if (affected > 0) console.log(`${execute ? 'deleted' : 'would delete'} ${affected.toString().padStart(5, ' ')}  ${step.label}`)
  }

  console.log('---')
  console.log(JSON.stringify({ ok: true, profile, executed: execute, adminUsersPreserved: adminCount, durationMs: Date.now() - startedAt, results }, null, 2))
}

main()
  .catch((error) => {
    console.error('AACT cleanup failed:', error?.message || error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
