import { readFileSync } from 'fs'
import { join } from 'path'

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1
}

function testSupervisorsApiAndUi() {
  const route = file('src/app/api/admin/supervisors/route.ts')
  assert(route.includes('export async function GET'), 'supervisors route must implement GET')
  assert(route.includes('export async function POST'), 'supervisors route must implement POST')
  assert(route.includes('export async function PATCH'), 'supervisors route must implement PATCH')
  assert(occurrences(route, 'requireAdmin()') >= 3, 'supervisors route must require admin for every verb')
  assert(route.includes('supervisedAdmissions'), 'supervisors list must include supervisedCount from supervisedAdmissions')
  assert(route.includes('hashPassword(password)'), 'supervisor create/reset must hash passwords with auth hashPassword')
  assert(route.includes('db.session.deleteMany({ where: { userId: id } })'), 'supervisor password reset/revoke must delete sessions')
  assert(route.includes('SUPERVISOR_HAS_STUDENTS'), 'supervisor revoke must be blocked when students are assigned')

  const ui = file('src/components/aact/AdminSupervisors.tsx')
  assert(occurrences(ui, '/api/admin/supervisors') >= 3, 'AdminSupervisors must use the dedicated supervisors API')
  assert(ui.includes('useAdminActionDialog') && ui.includes('confirmAction'), 'AdminSupervisors must confirm before supervisor revocation')
}

function testApprovedOnlyExamAssembly() {
  const policy = file('src/lib/unit-exam-policy.ts')
  assert(policy.includes('const selected = approved.slice(0, target)'), 'unit exam policy must select approved questions only')
  assert(policy.includes('currentEligibleCount: approved.length'), 'unit exam eligible count must be approved-only')

  const unitRoute = file('src/app/api/admin/unit-exams/generate/route.ts')
  assert(unitRoute.includes('في ${scoped.selection.pendingReviewCount} أسئلة بانتظار المراجعة'), 'unit exam shortage message must expose pending review count')
  assert(unitRoute.includes('const reviewRequired = false'), 'unit exams must not mark approved-only rebuilds as requiring review')
  assert(unitRoute.includes("const examStatus = reviewRequired ? 'DRAFT' : 'READY'"), 'unit exam ready/draft contract must stay explicit for approved-only rebuilds')

  const assembly = file('src/lib/program-exam-assembly.ts')
  assert(assembly.includes("item.status !== 'APPROVED'"), 'program exam qualified items must be approved-only')
  assert(assembly.includes("status: 'APPROVED'"), 'program exam candidate query must use APPROVED status')
  assert(assembly.includes("status: 'PENDING_REVIEW'"), 'program exam assembly must count pending-review questions for messaging')
  assert(assembly.includes("programId: exam.programId, status: 'PENDING_REVIEW'"), 'pending-review count must cover the program without SOURCE_GROUNDED filtering')
  assert(assembly.includes('في ${pendingReviewTotal} أسئلة بانتظار المراجعة'), 'program exam shortage message must include pending review count')
}

function testQuestionVerifierUsesOriginalBookChunk() {
  const job = file('src/lib/question-bank-job.ts')
  assert(job.includes('originalChunkText'), 'question-bank job must carry original BookChunk text')
  assert(job.includes('BookChunk #'), 'verifier source must include BookChunk number')
  assert(job.includes('originalChunkPageStart'), 'verifier source must include page metadata')
  assert(job.includes('db.bookChunk.findMany'), 'question-bank job must fetch original BookChunk rows')
  assert(job.includes('text: verifierSourceText(item)'), 'question verifier must receive original chunk source text')
  assert(job.includes("if (!original) return ''"), 'question verifier must not fall back to excerpt/summary when original BookChunk is missing')
  assert(job.includes("verificationReason: 'لا يوجد مقطع أصلي'"), 'questions without original BookChunk must remain pending review with an explicit reason')
  assert(job.includes("ORIGINAL_CHUNK_MISSING"), 'missing original BookChunk questions must be flagged for human review')

  const verifier = file('src/lib/question-verifier.ts')
  const literalEvidence = file('src/lib/evidence-validator.ts')
  assert(verifier.includes('validateLiteralEvidence'), 'question verifier must still call the literal evidence validator')
  assert(literalEvidence.includes('normalizeArabic'), 'literal evidence validator must retain Arabic normalization')
}

function testNoAcademicFallbacks() {
  const assessment = file('src/lib/supervisor-assessment-ai.ts')
  assert(assessment.includes("AI_UNAVAILABLE_MESSAGE = 'المساعد غير متاح حالياً، حاول بعد قليل'"), 'supervisor assessment must define explicit unavailable message')
  assert(!assessment.includes('fallbackQuestions('), 'supervisor assessment must not generate local fallback questions')
  assert(assessment.includes("code = 'AI_UNAVAILABLE'"), 'supervisor assessment unavailable errors must be machine-readable')

  const supervisorRoute = file('src/app/api/supervisor/assessments/route.ts')
  assert(supervisorRoute.includes("code: 'AI_UNAVAILABLE'"), 'supervisor route must return AI_UNAVAILABLE instead of academic fallback content')

  const defense = file('src/app/api/defense/route.ts')
  assert(!defense.includes('function fallbackLiveIntervention'), 'defense route must remove fallbackLiveIntervention')
  assert(defense.includes("AI_UNAVAILABLE_MESSAGE = 'المساعد غير متاح حالياً، حاول بعد قليل'"), 'defense route must use explicit unavailable message')
  assert(!defense.includes('مداخلة المستشار الذكي: سمعت إجابتك'), 'defense route must not keep canned academic intervention text')
}

function testIncompleteDefenseNeedsReview() {
  const defense = file('src/app/api/defense/route.ts')
  assert(defense.includes('scoreDefenseBreakdown(criteriaScores, { requireAllCriteria: true })'), 'defense end must use scored criteria coverage')
  assert(defense.includes('criteriaCovered.length < DEFENSE_CRITERIA.length'), 'defense end must not rely on message count only')
  assert(defense.includes("defenseStatus: 'NEEDS_REVIEW'"), 'incomplete defense must move to NEEDS_REVIEW')
  assert(defense.includes('aiScore: null'), 'incomplete defense must clear aiScore')
  assert(defense.includes('DEFENSE_CRITERIA_INCOMPLETE'), 'incomplete defense must record reason')
  assert(defense.includes('noRebalance: true'), 'incomplete defense must record that no rebalance occurred')
  assert(defense.includes('setTimeout(() => resolve(AI_UNAVAILABLE_MESSAGE), 4500)'), 'live defense timeout must return AI_UNAVAILABLE_MESSAGE')
  assert(defense.includes('لا توجد علامة آلية'), 'incomplete defense must avoid automatic scoring language')
}

function testExamErrorWiring() {
  const store = file('src/lib/store.ts')
  assert(store.includes('status?: number') && store.includes('code?: string'), 'api() errors must preserve status and code')
  assert(store.includes('err.status = res.status') && store.includes('err.code ='), 'api() must populate structured error fields')

  const detail = file('src/app/api/program-exam/detail/route.ts')
  assert(detail.includes("code: 'PENDING_PAYMENT'") || detail.includes("code: tuitionGate.code"), 'program exam detail must expose payment code')
  assert(detail.includes("code: 'ALREADY_PASSED'"), 'program exam detail must expose already-passed code')
  assert(detail.includes("code: 'ATTEMPT_EXPIRED'"), 'program exam detail must expose expired attempt code')

  const submit = file('src/app/api/program-exam/submit/route.ts')
  assert(submit.includes("code: 'ATTEMPT_EXPIRED'"), 'program exam submit must expose expired attempt code')

  const examView = file('src/components/aact/ExamView.tsx')
  assert(examView.includes('SEM1_REQUIRED'), 'ExamView must show a clear SEM1_REQUIRED message')
  assert(examView.includes('EXAM_NOT_READY_MARKED'), 'ExamView must show a clear EXAM_NOT_READY_MARKED message')
  assert(examView.includes("tab: 'payments'"), 'ExamView must navigate payment errors to payments')
  assert(examView.includes("tab: 'results'"), 'ExamView must navigate passed/expired attempts to results')
  assert(examView.includes('انتهت المحاولة وحُسبت صفر'), 'ExamView must show the exact expired-attempt message')
  assert(examView.includes('submittedRef.current = true'), 'ExamView must lock submission after expired attempt')
}

function testAdminAndApplyWiring() {
  const reps = file('src/components/aact/AdminRepresentativesTab.tsx')
  assert(reps.includes('تأكيد حذف ملف الممثل'), 'representative file deletion must require confirmation')
  assert(reps.includes('تأكيد رفض ملف الممثل'), 'representative file rejection must require confirmation')

  const extras = file('src/components/aact/AdminExtras.tsx')
  assert(extras.includes('disabled={busy} onClick={() => reprocessThesis(t)}'), 'AdminExtras reprocess button must be disabled while busy')
  assert(extras.includes('disabled={busy} onClick={() => thesisAction'), 'AdminExtras card approval/revision buttons must be disabled while busy')

  const apply = file('src/components/aact/ApplyView.tsx')
  assert(occurrences(apply, "fetch('/api/settings'") === 1, 'ApplyView must fetch /api/settings only once')
  assert(apply.includes('resolveAdmissionRequiredDocuments'), 'ApplyView must use shared required-document policy')

  const admissionRoute = file('src/app/api/admissions/route.ts')
  assert(admissionRoute.includes('resolveAdmissionRequiredDocuments'), 'admissions route must use shared required-document policy')
}

function testFailedBookReadRetry() {
  const books = file('src/components/aact/AdminBooks.tsx')
  assert(books.includes("job?.status === 'FAILED'"), 'AdminBooks must detect failed book read jobs')
  assert(books.includes('count < 3'), 'failed book read auto retry must be limited')
  assert(books.includes('5_000 * (2 ** (count - 1))'), 'failed book read auto retry must use backoff')
  assert(books.includes('إعادة محاولة قراءة الكتاب'), 'failed book read jobs must expose a manual retry button')
  assert(books.includes('retry-failed-chunks'), 'failed chunk retry path must remain available')
}

function testAlborihiProviderWiring() {
  const textAi = file('src/lib/text-ai.ts')
  assert(textAi.includes("| 'ALBORIHI'"), 'Text AI provider union must include Alborihi')
  assert(textAi.includes("ALBORIHI_DEFAULT_BASE_URL = 'https://alborihi-ai.com/api/public/dev/v1'"), 'Alborihi default base URL must match the documented public dev API')
  assert(textAi.includes("provider === 'ALBORIHI'"), 'Alborihi must have provider-specific catalog handling')
  assert(textAi.includes("case 'ALBORIHI': return s.alborihiBaseUrl ? s.alborihiKeys : []"), 'Alborihi keys must be routed through providerKeys with a base URL guard')

  const settings = file('src/lib/settings.ts')
  assert(settings.includes('ALBORIHI_API_KEYS'), 'Admin settings must expose Alborihi API keys')
  assert(settings.includes('ALBORIHI_BASE_URL'), 'Admin settings must expose Alborihi base URL')

  const env = file('.env.example')
  assert(env.includes('AACT_SECRETS_KEY'), '.env.example must document the admin-secret encryption key')
  assert(env.includes('ALBORIHI_API_KEYS'), '.env.example must document Alborihi keys')
  assert(env.includes('ALBORIHI_BASE_URL="https://alborihi-ai.com/api/public/dev/v1"'), '.env.example must document Alborihi base URL')

  const settingsRoute = file('src/app/api/settings/route.ts')
  assert(settingsRoute.includes('ENCRYPTED_TEXT_AI_SECRET_SETTING_RE'), 'settings route must encrypt external AI secrets saved from the admin UI')
  assert(settingsRoute.includes('ALBORIHI'), 'settings route encryption allowlist must include Alborihi')
}

testSupervisorsApiAndUi()
testApprovedOnlyExamAssembly()
testQuestionVerifierUsesOriginalBookChunk()
testNoAcademicFallbacks()
testIncompleteDefenseNeedsReview()
testExamErrorWiring()
testAdminAndApplyWiring()
testFailedBookReadRetry()
testAlborihiProviderWiring()

console.log('✓ ai/ui wiring behavioral checks passed')
