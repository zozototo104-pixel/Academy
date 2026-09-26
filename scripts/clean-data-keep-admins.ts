import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

type CleanupProfile = 'launch' | 'factory'
type CountResult = { count: number }
type Step = {
  key: string
  label: string
  count: number
  execute: () => Promise<CountResult>
}

const DATA_CLEANUP_CONFIRMATION = 'KEEP_ADMINS_CLEAN_DATABASE'
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
  if (raw === 'factory') return 'factory'
  if (raw === 'launch') return 'launch'
  throw new Error(`Unknown cleanup profile "${raw}". Use --profile launch or --profile factory.`)
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
      { titleAr: { contains: 'رحلة كاملة QA' } },
      { titleAr: { contains: 'جودة رحلة كاملة QA' } },
      { titleEn: { contains: 'QA Full Journey' } },
    ],
  }
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

  if (execute && process.env.AACT_CONFIRM_DATA_CLEANUP !== DATA_CLEANUP_CONFIRMATION) {
    throw new Error(`Refusing destructive cleanup. Set AACT_CONFIRM_DATA_CLEANUP=${DATA_CLEANUP_CONFIRMATION} and run again.`)
  }

  if (execute && profile === 'factory' && process.env.AACT_CONFIRM_FACTORY_RESET !== FACTORY_CONFIRMATION) {
    throw new Error(`Factory cleanup also deletes academic content. Set AACT_CONFIRM_FACTORY_RESET=${FACTORY_CONFIRMATION} to allow it.`)
  }

  const steps = profile === 'factory' ? await buildFactorySteps() : await buildLaunchSteps()

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
