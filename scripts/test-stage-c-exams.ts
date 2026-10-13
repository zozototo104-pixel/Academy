import { readFileSync } from 'fs'
import { join } from 'path'

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function testCentralCompletionOnly() {
  const submit = file('src/app/api/exam/submit/route.ts')
  assert(submit.includes("completeEnrollmentIfEligible({ enrollmentId: enrollment.id })"), 'unit exam submit must delegate completion to the central service')
  assert(!submit.includes('programUnits = await db.unit.count'), 'unit exam submit must not locally count all program units to issue certificates')
  assert(!submit.includes('data: { status: \'COMPLETED\''), 'unit exam submit must not directly mark Enrollment COMPLETED')
  assert(!submit.includes('AACT-${new Date().getFullYear()}'), 'unit exam submit must not mint local certificate numbers')

  const central = file('src/lib/enrollment-completion.ts')
  assert(central.includes('completeEnrollmentIfEligible'), 'central completion service must exist')
  assert(central.includes('db.$transaction'), 'central completion service must run inside a transaction')
  assert(central.includes('evaluateProgramCertificateEligibility'), 'central completion must use certificate eligibility')
  assert(central.includes('tx.enrollment.update'), 'central completion service must be the place that completes enrollment')
  assert(central.includes('tx.certificate.create'), 'central completion service must be the place that issues program certificates')
  assert(central.includes("SELECT nextval('\"Certificate_serial_seq\"')"), 'central completion must allocate certificate serials from the database sequence')
  assert(central.includes('createProgramCompletionCertificateWithRetry'), 'central completion must retry certificate creation on unique serial conflicts')
  const programSubmit = file('src/app/api/program-exam/submit/route.ts')
  assert(programSubmit.includes('completeEnrollmentIfEligible({ enrollmentId: enrollment.id })'), 'program exam submit must also delegate eligible completion to the central service')
  assert(programSubmit.includes("return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })"), 'program exam submit must return 400 for malformed JSON')
  assert(submit.includes("return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })"), 'unit exam submit must return 400 for malformed JSON')
}

function testEligibilityRequiresAllAcademicAndFinancialInputs() {
  const finalGrade = file('src/lib/final-grade.ts')
  assert(finalGrade.includes('unitQuizAverage') && finalGrade.includes('exams.length'), 'final grade must require all ready unit exams')
  assert(finalGrade.includes("status: 'GRADED', passed: true"), 'unit exam eligibility must require passed graded attempts')
  assert(finalGrade.includes('programExamAverage'), 'final grade must require program exams')
  assert(finalGrade.includes('status: \'GRADED\', passed: true, appealStatus: { not: \'PENDING\' }'), 'program exam eligibility must require passed graded non-pending attempts')
  assert(finalGrade.includes('assignmentAverage'), 'final grade must include published assignments')
  assert(finalGrade.includes("where: { programId, status: 'PUBLISHED' }"), 'published assignments must be enumerated')
  assert(finalGrade.includes("submission.status !== 'GRADED'"), 'published assignments must be submitted and graded')
  assert(finalGrade.includes('thesisScores'), 'masters/doctorate eligibility must include thesis/defense scores')
  assert(finalGrade.includes('Raw percentage: certification decisions compare this unrounded value'), 'passing decisions must use raw scores and keep rounding for display only')
  assert(finalGrade.includes('function best('), 'final grade must use a best-attempt helper')
  assert(finalGrade.includes('const bestAttemptScore = best(attempts.map'), 'final grade must use the best successful attempt per exam rather than averaging attempts')
  assert(!finalGrade.includes('const best = avg(attempts.map'), 'final grade must not average all successful attempts for a single exam')

  const eligibility = file('src/lib/certificate-eligibility.ts')
  assert(eligibility.includes('finalGrade.score < CERTIFICATE_PASS_SCORE'), 'certificate eligibility must compare the raw final score against pass score')
  assert(!eligibility.includes('round1(finalGrade.score) < CERTIFICATE_PASS_SCORE'), 'certificate eligibility must not use rounded score for pass/fail')
  assert(eligibility.includes('paymentEligibilityError'), 'certificate eligibility must include paid-fee checks')
  assert(eligibility.includes('tuitionPaidTotal'), 'certificate eligibility must require paid or waived tuition')

  const central = file('src/lib/enrollment-completion.ts')
  assert(central.includes('financialFailure'), 'central completion must include financial eligibility')
  assert(central.includes('tuitionPaidTotal'), 'central completion must require tuition to be paid or waived')
  assert(central.includes('PAYMENT_REQUIRED'), 'central completion must produce a payment-required failure')
}

function testAdminCertificatesUseCentralService() {
  const route = file('src/app/api/admin/certificates/route.ts')
  assert(route.includes('completeEnrollmentIfEligible'), 'admin certificates route must use central completion service')
  assert(!route.includes('db.certificate.create'), 'admin certificates route must not create certificates directly')
  assert(!route.includes('nextCertSerial'), 'admin certificates route must not mint certificate serials directly')
  assert(route.includes('status: result.httpStatus || 422'), 'admin certificates must return 422 for missing registration/payment/eligibility')
}

function testUnitExamAttemptSafety() {
  const submit = file('src/app/api/exam/submit/route.ts')
  assert(submit.includes('UNIT_EXAM_SUBMIT_GRACE_MS = 2 * 60 * 1000'), 'unit exam submit must allow only a two-minute grace period')
  assert(submit.includes('unitAttemptDeadline(activeAttempt.createdAt)'), 'unit exam submit must use server-created attempt time')
  assert(submit.includes("code: 'UNIT_EXAM_EXPIRED'"), 'unit exam submit must reject late submissions')

  const detail = file('src/app/api/exam/detail/route.ts')
  assert(detail.includes("status: 'GRADED', passed: true"), 'unit exam detail must look for an already passed attempt')
  assert(detail.includes("reason: 'PASSED_ALREADY'"), 'unit exam detail must block a new attempt after passing')
}

function testDefenseIncompleteCriteriaNeedsReview() {
  const defense = file('src/app/api/defense/route.ts')
  assert(defense.includes('{ requireAllCriteria: true }'), 'defense scoring must require all five criteria')
  assert(defense.includes('const incompleteCriteria = criteriaCovered.length < DEFENSE_CRITERIA.length'), 'defense must detect incomplete criteria coverage')
  assert(defense.includes("defenseStatus: incompleteCriteria ? 'NEEDS_REVIEW' : 'COMPLETED'"), 'early defense ending must become NEEDS_REVIEW')
  assert(defense.includes('const aiScore = incompleteCriteria ? null : weighted.score'), 'early defense ending must not rebalance partial scores')
  assert(defense.includes('noRebalance: incompleteCriteria'), 'defense breakdown must record that no rebalance occurred')
}

function testSchemaAndMigrationSafety() {
  const schema = file('prisma/schema.prisma')
  assert(schema.includes('enrollment   Enrollment? @relation(fields: [enrollmentId], references: [id], onDelete: Restrict)'), 'Certificate.enrollmentId must be a restrictive FK')
  assert(schema.includes('@@unique([enrollmentId, type])'), 'Certificate must be unique by enrollmentId and type')
  assert(schema.includes('Enrollment[]') && schema.includes('certificates Certificate[]'), 'User/Enrollment certificate relations must be declared')
  assert(schema.includes('user           User      @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'Enrollment.user must restrict deletes')
  assert(schema.includes('program        Program   @relation(fields: [programId], references: [id], onDelete: Restrict)'), 'Enrollment.program must restrict deletes')
  assert(schema.includes('user        User      @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'ExamAttempt.user must restrict deletes')
  assert(schema.includes('user        User     @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'ThesisSubmission/ProgramExamAttempt user deletes must restrict')

  const migration = file('prisma/migrations/20261013153000_stage_c_completion_certificates/migration.sql')
  assert(migration.includes('CERTIFICATE_ORPHAN_ENROLLMENT_NULLIFIED'), 'migration must audit orphan certificate enrollment links before FK creation')
  assert(migration.includes('CERTIFICATE_DUPLICATE_ENROLLMENT_TYPE_INVALIDATED'), 'migration must audit duplicate enrollment/type certificates')
  assert(migration.includes('SET "enrollmentId" = NULL'), 'migration must unlink unsafe certificate rows instead of deleting them')
  assert(migration.includes('"valid" = false'), 'migration must invalidate duplicate certificate rows instead of deleting them')
  assert(!migration.includes('DELETE FROM "Certificate"'), 'migration must not delete certificates')
  assert(migration.includes('CREATE SEQUENCE IF NOT EXISTS "Certificate_serial_seq"'), 'migration must create an atomic certificate serial sequence')
  assert(migration.includes('ON DELETE RESTRICT'), 'migration must apply restrictive foreign keys')
}

function testQuestionBankMethodologyUntouched() {
  const generation = file('src/app/api/admin/program-exams/generate/route.ts')
  assert(generation.includes('advanceProgramExamFromVerifiedBank'), 'program exam generation must still use the verified question-bank assembly path')
  assert(!generation.includes('Math.random()'), 'program exam generation must not switch to random question-bank methodology')
}

testCentralCompletionOnly()
testEligibilityRequiresAllAcademicAndFinancialInputs()
testAdminCertificatesUseCentralService()
testUnitExamAttemptSafety()
testDefenseIncompleteCriteriaNeedsReview()
testSchemaAndMigrationSafety()
testQuestionBankMethodologyUntouched()

console.log('✓ Stage C exam/certificate safety checks passed')
