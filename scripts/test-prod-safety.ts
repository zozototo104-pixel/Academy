import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import {
  hasAactTestRecipient,
  isAactTestEmail,
  isPrivateStorageKey,
  qaProdFixturesAllowed,
  remainingDeadlineMs,
} from '../src/lib/prod-safety'
import { canAccessStorageKeyWithClient } from '../src/lib/file-access-policy'
import { getStorageDownloadPathForKey, isPrivateIp } from '../src/lib/storage'
import { __handleFileGetForTests } from '../src/app/api/files/[...key]/route'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function testDeadlineMath() {
  const future = Date.now() + 30_000
  const remaining = remainingDeadlineMs(future, 60_000)
  assert(remaining > 25_000 && remaining <= 30_000, 'deadline after 30 seconds must return approximately 30000ms, not zero')
  assert(remainingDeadlineMs(Date.now() - 1_000, 60_000) === 0, 'expired deadline must return zero')
}

function testProductionFixtureGuards() {
  assert(!qaProdFixturesAllowed({ VERCEL_ENV: 'production' } as any), 'production QA fixtures must be blocked by default')
  assert(qaProdFixturesAllowed({ VERCEL_ENV: 'production', QA_ALLOW_PROD_FIXTURES: 'true' } as any), 'explicit production QA fixture override must be honored')
  assert(qaProdFixturesAllowed({ VERCEL_ENV: 'preview' } as any), 'preview QA fixtures must remain allowed')

  const fullJourney = file('src/app/api/admin/full-journey/route.ts')
  assert(fullJourney.includes('qaProdFixturesAllowed()'), 'full-journey route must use the production fixture guard')
  assert(fullJourney.includes('QA_ALLOW_PROD_FIXTURES=true'), 'full-journey route must document the explicit production override')

  const launchQuality = file('src/app/api/admin/launch-quality/route.ts')
  assert(launchQuality.includes('qaProdFixturesAllowed()'), 'launch-quality setup must use the production fixture guard')
}

function testWorkflowTargetsQaOnly() {
  const workflow = file('.github/workflows/full-journey.yml')
  assert(!workflow.includes('default: "https://academy-raqaba.vercel.app"'), 'full journey workflow must not default to production')
  assert(workflow.includes('QA_PREVIEW_BASE_URL'), 'full journey workflow should prefer QA preview URL')
  assert(workflow.includes('E2E_QA_ONLY: "1"'), 'full journey workflow must run in QA-only mode')

  const launchQuality = file('.github/workflows/launch-quality.yml')
  assert(!launchQuality.includes('default: "https://academy-raqaba.vercel.app"'), 'launch quality workflow must not default to production')
  assert(launchQuality.includes('QA_PREVIEW_BASE_URL'), 'launch quality workflow should prefer QA preview URL')

  const validator = file('scripts/validate-e2e-base-url.sh')
  assert(validator.includes('academy-raqaba.vercel.app'), 'E2E validator must know production origin')
  assert(validator.includes('Refusing to run QA E2E against a production origin'), 'E2E validator must refuse production in QA-only mode')
}

function testFinallyCleanup() {
  const spec = file('tests/e2e/full-journey.spec.ts')
  assert(spec.includes('finally'), 'full journey test must cleanup in finally')
  assert(spec.includes('cleanupFullJourney(page.request'), 'full journey finally must call cleanupFullJourney')
  assert(!spec.includes('test.afterEach'), 'full journey cleanup must not rely on afterEach only')
}

function testPrivateStoragePolicy() {
  for (const key of [
    'admissions/2026/passport.pdf',
    'payment-proofs/2026/proof.png',
    'assignments/submission.docx',
    'theses/final.pdf',
    'backups/export.zip',
    'service-deliverables/result.pdf',
  ]) {
    assert(isPrivateStorageKey(key), `${key} must be classified as private`)
  }
  assert(!isPrivateStorageKey('public/catalog.pdf'), 'public catalog key must not be classified as private')

  const storage = file('src/lib/storage.ts')
  assert(storage.includes('if (isPrivateStorageKey(cleanKey)) return null'), 'private storage keys must never receive public URLs')
  assert(storage.includes('getStorageDownloadPathForKey'), 'private upload result must point to controlled download route')
  assert(storage.includes("path.join(process.cwd(), 'public', 'uploads')"), 'private file reader must support legacy public/uploads fallback after authorization')

  const route = file('src/app/api/files/[...key]/route.ts')
  assert(route.includes('const SIGNED_URL_TTL_SECONDS = 5 * 60'), 'file route must issue 5-minute signed URLs')
  assert(route.includes("readStoredFile({ provider: 'local', key })"), 'file route must serve authorized legacy local files through signed local downloads')
  assert(route.includes('canAccessStorageKey(key, user)'), 'file route must delegate authorization to the shared file access policy')

  const policy = file('src/lib/file-access-policy.ts')
  assert(policy.includes("user.role === 'ADMIN'"), 'file access policy must allow admins')
  assert(policy.includes('admissionDocument'), 'file access policy must authorize admission document owners')
  assert(policy.includes('serviceDeliverable'), 'file access policy must authorize published service deliverable owners')
  assert(policy.includes('paymentProof'), 'file access policy must authorize payment proof owners')
  assert(policy.includes('assignmentSubmission'), 'file access policy must authorize assignment owners')
  assert(policy.includes('thesisSubmission'), 'file access policy must authorize thesis owners')
  assert(policy.includes('backups/'), 'file access policy must treat backups as admin-only private files')

  const privateMigration = file('scripts/migrate-private-file-storage.ts')
  assert(privateMigration.includes('executed: execute'), 'private file migration must default to dry-run and report execute mode')
  assert(privateMigration.includes("public', 'uploads"), 'private file migration must inspect legacy public/uploads files')
  assert(privateMigration.includes('storage-key-updated'), 'private file migration must update database storage keys after execute')
  assert(privateMigration.includes('would-update-storage-key'), 'private file migration dry-run must report pending storage key backfills')
  assert(privateMigration.includes('ServiceDeliverable'), 'private file migration must cover service deliverables')

  const adminAdmissions = file('src/app/api/admin/admissions/route.ts')
  assert(adminAdmissions.includes('getStorageDownloadPathForKey(file.storageKey)'), 'admin admission documents must expose protected file URLs')
  const studentAdmissions = file('src/app/api/admissions/route.ts')
  assert(studentAdmissions.includes('files: { select: { id: true, docType: true, fileName: true, size: true, storageKey: true } }'), 'student admissions GET must select document storage keys')
  assert(studentAdmissions.includes('fileUrl: f.storageKey ? getStorageDownloadPathForKey(f.storageKey) : null'), 'student admissions GET must expose protected document file URLs')
  const dashboardSummary = file('src/app/api/my/dashboard-summary/route.ts')
  assert(dashboardSummary.includes('files: { select: { id: true, docType: true, fileName: true, size: true, storageKey: true } }'), 'student dashboard summary must select admission documents')
  assert(dashboardSummary.includes('documents: (a.files || []).map') && dashboardSummary.includes('downloadUrl: file.storageKey ? getStorageDownloadPathForKey(file.storageKey) : null'), 'student dashboard summary must expose protected admission document links')
  const assignments = file('src/app/api/assignments/route.ts')
  assert(assignments.includes('getStorageDownloadPathForKey(submission.fileStorageKey)'), 'student assignment files must expose protected file URLs')
  assert(getStorageDownloadPathForKey('payment-proofs/2026/p.png').startsWith('/api/files/'), 'protected file URLs must be rooted at /api/files')
  assert(getStorageDownloadPathForKey('admissions/a b.pdf') === '/api/files/admissions/a%20b.pdf', 'protected file URLs must encode path segments and spaces')
  const dashboard = file('src/components/aact/DashboardView.tsx')
  assert(dashboard.includes('fileUrl?: string | null') && dashboard.includes('downloadUrl?: string | null'), 'student dashboard assignment submission type must include protected file URLs')
  assert(dashboard.includes('href={submission.fileUrl || submission.downloadUrl ||') && dashboard.includes('تحميل ملفي'), 'student dashboard assignment download href must use fileUrl || downloadUrl')
  assert(dashboard.includes('studentSummary.summary.latestAdmission?.documents') && dashboard.includes('وثائق الطلب'), 'student dashboard must expose protected admission document links')
  const thesis = file('src/app/api/thesis/route.ts')
  assert(thesis.includes('getStorageDownloadPathForKey(thesis.fileStorageKey)'), 'student thesis files must expose protected file URLs')
  const adminAssignments = file('src/app/api/admin/assignments/route.ts')
  assert(adminAssignments.includes('getStorageDownloadPathForKey(s.fileStorageKey)'), 'admin assignment submissions must expose protected file URLs')
  const adminThesis = file('src/app/api/admin/thesis/route.ts')
  assert(adminThesis.includes('getStorageDownloadPathForKey(fileStorageKey)'), 'admin thesis file URLs must be protected')
  assert(adminThesis.includes('getStorageDownloadPathForKey(recordingStorageKey)'), 'admin thesis recording URLs must be protected')
  const deliverables = file('src/app/api/service-deliverables/route.ts')
  assert(deliverables.includes('getStorageDownloadPathForKey(storageKey)'), 'service deliverables must expose protected file URLs')
  const studentPayments = file('src/app/api/payments/route.ts')
  assert(studentPayments.includes('storageKey: true') && !studentPayments.includes('storageUrl: true'), 'student payment proofs may select storageKey internally but must not select storageUrl')
  assert(studentPayments.includes('const { storageKey, storageUrl, ...safeProof } = proof as any'), 'student payment proof responses must strip raw storage fields')
  assert(studentPayments.includes('fileUrl: storageKey ? getStorageDownloadPathForKey(storageKey) : null'), 'student payment proofs must expose protected file URLs')
  const adminPayments = file('src/app/api/admin/payments/route.ts')
  assert(adminPayments.includes('const { storageKey, storageUrl, ...safeProof } = proof || {}'), 'admin payment proof responses must strip raw storage fields')
  assert(adminPayments.includes('safeProof.id ? `/api/admin/payments/proofs/${encodeURIComponent(safeProof.id)}/download` : null'), 'admin payment proofs, including legacy storageUrl-only rows, must expose protected admin download URLs')
  assert(!adminPayments.includes('isPrivateStorageKey'), 'admin payment proof response shaping must not expose or depend on raw storage keys')
  const dashboardExtras = file('src/components/aact/DashboardExtras.tsx')
  assert(dashboardExtras.includes('downloadUrl?: string | null') && dashboardExtras.includes('تحميل الإيصال'), 'student dashboard payments must display protected receipt links')
  const adminPaymentProofDownload = file('src/app/api/admin/payments/proofs/[id]/download/route.ts')
  assert(adminPaymentProofDownload.includes('await requireAdmin()') && adminPaymentProofDownload.includes('readStoredFile({'), 'admin payment proof download route must require admin and read stored files')
  const adminBooks = file('src/components/aact/AdminBooks.tsx')
  assert(adminBooks.includes('s.fileUrl || s.downloadUrl'), 'admin assignment inline list must display protected file URLs')
  assert(adminBooks.includes('submission.fileUrl || submission.downloadUrl'), 'admin assignment grading cards must display protected file URLs')
  assert(adminBooks.includes('gradingDialog.submission.fileUrl || gradingDialog.submission.downloadUrl'), 'admin assignment grading dialog must display protected file URLs')
  const adminExtras = file('src/components/aact/AdminExtras.tsx')
  assert(!adminExtras.includes('storageKey') && !adminExtras.includes('storageUrl'), 'AdminExtras must not expose raw payment storage fields')
  assert(adminExtras.includes('proof.fileUrl || proof.downloadUrl'), 'AdminExtras payment proofs must use protected receipt URLs')
  assert(adminExtras.includes('فتح ملف البحث'), 'admin thesis UI must expose protected thesis file link')
  assert(adminExtras.includes('minutesThesis.recordingUrl ||'), 'admin thesis minutes dialog must use protected recording URL')
  assert(adminExtras.includes('showRecording.recordingUrl ||'), 'admin thesis recording dialog must use protected recording URL')
}

function mockFileAccessClient(key: string, owner: { userId: string; email: string }) {
  const empty = { findFirst: async () => null }
  return {
    admissionDocument: { findFirst: async (args: any) => args.where?.storageKey === key ? { admission: owner } : null },
    serviceDeliverable: { findFirst: async (args: any) => args.where?.storageKey === key ? { admission: owner } : null },
    paymentProof: empty,
    assignmentSubmission: empty,
    thesisSubmission: empty,
  }
}

async function invokeProtectedFileRoute(key: string, user: any, allowed: boolean) {
  const req = new NextRequest(`https://academy.test/api/files/${key}?format=json`, { headers: { accept: 'application/json' } })
  return __handleFileGetForTests(req, { params: { key: key.split('/') } }, {
    requireUser: async () => user,
    canAccessStorageKey: async () => allowed,
    readStoredFile: async () => ({ buffer: Buffer.from('private-file'), mimeType: 'application/pdf' }),
    signLocalStorageDownloadPath: (storageKey: string) => `/api/files/${storageKey}?download=1&expires=1&signature=test-signature`,
    createSignedStorageUrlForKey: () => null,
    now: () => 1_700_000_000_000,
  })
}

async function testFileAccessPolicyBehavior() {
  const key = 'admissions/legacy/passport.pdf'
  const owner = { userId: 'student-owner', email: 'owner@example.com' }
  const client = mockFileAccessClient(key, owner)
  assert(await canAccessStorageKeyWithClient(client, key, { id: 'student-owner', email: 'owner@example.com', role: 'STUDENT' }), 'file owner must be authorized')
  assert(!(await canAccessStorageKeyWithClient(client, key, { id: 'student-other', email: 'other@example.com', role: 'STUDENT' })), 'another student must receive 403-equivalent denial')
  assert(await canAccessStorageKeyWithClient(client, key, { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' }), 'admin must be authorized')

  assert((await invokeProtectedFileRoute(key, { id: 'student-owner', email: 'owner@example.com', role: 'STUDENT' }, true)).status === 200, 'protected file route must return 200 for the owner')
  assert((await invokeProtectedFileRoute(key, { id: 'student-other', email: 'other@example.com', role: 'STUDENT' }, false)).status === 403, 'protected file route must return 403 for another student')
  assert((await invokeProtectedFileRoute(key, { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' }, true)).status === 200, 'protected file route must return 200 for admins')
  assert((await invokeProtectedFileRoute('admissions/legacy/from-file-url.pdf', { id: 'student-owner', email: 'owner@example.com', role: 'STUDENT' }, true)).status === 200, 'legacy fileUrl rows must open through /api/files after backfill')
  assert((await invokeProtectedFileRoute('service-deliverables/final/report.pdf', { id: 'student-owner', email: 'owner@example.com', role: 'STUDENT' }, true)).status === 200, 'service-deliverables files must open through /api/files for authorized users')
}

function testOfficialSettingsDeploymentHook() {
  const pkg = JSON.parse(file('package.json'))
  const build = String(pkg.scripts?.build || '')
  assert(build.includes('tsx scripts/prisma-deploy.ts && tsx scripts/migrate-official-ai-settings.ts'), 'official AI settings migration must run immediately after prisma deploy')
  assert(pkg.scripts?.['settings:migrate:official-ai'] === 'tsx scripts/migrate-official-ai-settings.ts', 'package.json must expose official settings migration script')
}

function testAiDeadlines() {
  const chat = file('src/app/api/chat/route.ts')
  assert(chat.includes('export const maxDuration = 60'), 'chat route must export maxDuration')
  assert(chat.includes('const deadlineMs = deadlineFromNow(55_000)'), 'chat route must create one shared deadline')
}

function testGradingCertificateFlowRegressions() {
  const schema = file('prisma/schema.prisma')
  assert(schema.includes('appealStatus   String?  @default("NONE")'), 'program exam appealStatus must be nullable')
  assert(file('prisma/migrations/202610141307_program_exam_appeal_status_nullable/migration.sql').includes('ALTER COLUMN "appealStatus" DROP NOT NULL'), 'appealStatus nullable migration must be present')

  const finalGrade = file('src/lib/final-grade.ts')
  assert(finalGrade.includes("OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }]"), 'final grade must include normal attempts with null appealStatus')
  assert(finalGrade.includes("attempt.appealStatus === 'REVIEWED' && typeof attempt.finalScore === 'number'"), 'final grade must prefer reviewed appeal finalScore')

  for (const route of ['src/app/api/exam/detail/route.ts', 'src/app/api/exam/submit/route.ts', 'src/app/api/program-exam/detail/route.ts', 'src/app/api/program-exam/submit/route.ts', 'src/app/api/admin/program-exam-questions/route.ts']) {
    const code = file(route)
    assert(code.includes('EXAM_HAS_NO_QUESTIONS'), `${route} must reject exams with no published questions/points`)
  }

  const programDetail = file('src/app/api/program-exam/detail/route.ts')
  assert(programDetail.includes("code: 'ALREADY_PASSED'") && programDetail.includes("code: 'SUBMITTED'"), 'program exam detail must keep compatible already-passed and submitted blocking codes')

  const attemptsReview = file('src/app/api/admin/attempts-review/route.ts')
  assert(attemptsReview.includes('completeEnrollmentIfEligible') && attemptsReview.includes('completeReviewedAttemptIfEligible'), 'review approval must complete enrollment after transaction')

  const appeal = file('src/app/api/program-exam/appeal/route.ts')
  assert(appeal.includes("attempt.status !== 'GRADED'"), 'appeals must only be accepted for graded attempts')
  assert(appeal.includes('finalScore: clamped') && appeal.includes('completeEnrollmentIfEligible'), 'accepted appeals must set finalScore and try certificate completion')

  const examView = file('src/components/aact/ExamView.tsx')
  assert(examView.includes("d?.status === 'NEEDS_REVIEW'") && examView.includes('إجاباتك محفوظة للمراجعة'), 'ExamView must handle NEEDS_REVIEW without score display')
  for (const code of ['PASSED_ALREADY', 'SUBMITTED', 'UNIT_EXAM_EXPIRED', 'ATTEMPT_ALREADY_CLAIMED', 'EXAM_HAS_NO_QUESTIONS']) assert(examView.includes(code), `ExamView must handle ${code}`)

  const defenseRoom = file('src/components/aact/DefenseRoom.tsx')
  assert(defenseRoom.includes("thesis.defenseStatus === 'NEEDS_REVIEW' || thesis.needsReview === true"), 'DefenseRoom must detect committee review state')
  assert(defenseRoom.includes('المناقشة قيد مراجعة اللجنة') && defenseRoom.includes('disabled={busy || defenseUnderReview'), 'DefenseRoom must block actions while under review')

  for (const workflow of ['.github/workflows/prisma-baseline-prepare.yml', '.github/workflows/prisma-baseline-mark-applied.yml']) {
    const code = file(workflow)
    const runBlocks = code.split(/\n\s*run: \|\n/).slice(1).join('\n')
    assert(!runBlocks.includes('${{ inputs.'), `${workflow} must not use inputs context directly inside run blocks`)
  }
}

function testWhatsAppMinimalSafety() {
  const route = file('src/app/api/webhooks/whatsapp/route.ts')
  assert(route.includes('const fromEncrypted = encryptWhatsAppPhone(message.from) || null'), 'WhatsApp inbound payload must keep the encrypted sender before redaction')
  assert(route.includes('return { ...payload, message: { ...(payload?.message || {}), fromEncrypted } }'), 'WhatsApp inbound payload must restore encrypted sender after redactDeep')
  assert(route.includes('decryptWhatsAppPhone(message?.fromEncrypted)'), 'saved WhatsApp inbound events must recover the encrypted sender for cron/after processing')
  assert(route.includes("{ status: 'RECEIVED' }") && route.includes("{ status: 'FAILED' }"), 'WhatsApp event processing must atomically claim RECEIVED or FAILED events')
  assert(!route.includes("{ status: 'PROCESSING', updatedAt"), 'WhatsApp event processing must not double-claim an in-flight event')
  assert(route.includes('if (!claim.count) return'), 'WhatsApp event processing must skip when the atomic claim was not acquired')
  assert(route.includes('allowZaiFallback: true'), 'WhatsApp voice transcription must allow the audio fallback path')
  const adminView = file('src/components/aact/AdminView.tsx')
  const adminExtras = file('src/components/aact/AdminExtras.tsx')
  assert(!adminView.includes('AdminWhatsAppFailuresTab') && !adminView.includes('whatsapp-failures') && !adminView.includes('إخفاقات الواتساب'), 'AdminView must not expose WhatsApp failures UI')
  assert(!adminExtras.includes('AdminWhatsAppFailuresTab') && !adminExtras.includes('whatsapp-failures') && !adminExtras.includes('إخفاقات الواتساب'), 'AdminExtras must not expose WhatsApp failures UI')
}

function testAactTestRecipientBlocks() {
  assert(isAactTestEmail('student@aact.test'), 'aact.test address must be detected')
  assert(isAactTestEmail('QA Student <student@aact.test>'), 'aact.test display-name address must be detected')
  assert(hasAactTestRecipient('Admin <admin@example.com>; QA Student <student@aact.test>'), 'display-name recipient lists must be blocked')
}

function testDependencyPins() {
  const pkg = JSON.parse(file('package.json'))
  assert(pkg.dependencies.next === '^16.4.1', 'Next.js dependency must be updated to the patched security release')
  assert(pkg.dependencies.react === '^19.3.1', 'React dependency must be updated')
  assert(pkg.dependencies['react-dom'] === '^19.3.1', 'React DOM dependency must be updated')
  assert(pkg.dependencies.sharp === '^0.35.5', 'sharp dependency must be updated to the patched image optimizer release')
  assert(pkg.devDependencies['eslint-config-next'] === '^16.4.1', 'eslint-config-next must match Next.js patch')
}

function testPrismaDeployPreviewPushSkips() {
  const command = process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  const result = spawnSync(command, ['scripts/prisma-deploy.ts', '--push'], {
    cwd: process.cwd(),
    env: { ...process.env, VERCEL_ENV: 'preview', DATABASE_URL: 'postgresql://user:pass@example.invalid:5432/db' },
    encoding: 'utf8',
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  assert(result.status === 0, `prisma-deploy --push in preview must skip successfully: ${output}`)
  assert(output.includes('skipped'), 'prisma-deploy --push in preview must print skipped')
}

function testSecurityBatchAFollowup() {
  const waiverLib = file('src/lib/payment-waivers.ts')
  assert(waiverLib.includes('class ActivePaymentWaiverExistsError') && waiverLib.includes("code = 'ACTIVE_WAIVER_EXISTS'") && waiverLib.includes('status = 409'), 'payment waivers must expose a 409 ACTIVE_WAIVER_EXISTS error')
  assert(waiverLib.includes('db.$transaction(async (tx)') && waiverLib.includes('SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE'), 'payment waiver creation must lock the payment row inside a transaction')
  assert(waiverLib.includes("status: { in: ['ISSUED', 'VERIFIED'] }") && waiverLib.includes('throw new ActivePaymentWaiverExistsError(activeWaiver.codePreview)'), 'payment waiver transaction must reject existing active codes before create')
  assert(!waiverLib.includes("data: { status: 'CANCELLED' }"), 'payment waiver creation must not cancel active codes to create a replacement')
  assert(waiverLib.includes("PAYMENT_WAIVER_CODE_CREATED") && waiverLib.includes('waiver.codePreview'), 'payment waiver audit logs must use codePreview only')

  const waiverRoute = file('src/app/api/admin/payments/waivers/route.ts')
  assert(waiverRoute.includes('ActivePaymentWaiverExistsError') && waiverRoute.includes('status: 409') && waiverRoute.includes("code: 'ACTIVE_WAIVER_EXISTS'"), 'waiver API must return 409 ACTIVE_WAIVER_EXISTS for duplicate active code issuance')

  const adminExtras = file('src/components/aact/AdminExtras.tsx')
  assert(adminExtras.includes('activeWaiverForPayment') && adminExtras.includes('كود إعفاء نشط'), 'admin payments UI must show an active waiver badge/state')
  assert(adminExtras.includes('generatedWaiverCodes') && adminExtras.includes('نسخ الكود') && adminExtras.includes('تم النسخ'), 'admin payments UI must expose one-time raw code copy state after generation')
  assert(adminExtras.includes('navigator.clipboard.writeText') && adminExtras.includes("document.execCommand('copy')"), 'waiver code copy must use clipboard with textarea execCommand fallback')
  assert(adminExtras.includes('disabled={busy}') && adminExtras.includes('بعد التحديث يظهر رمز مختصر فقط'), 'waiver buttons must disable while/after active code issuance and show only preview after refresh')

  const adminPayments = file('src/app/api/admin/payments/route.ts')
  assert(adminPayments.includes('select: { id: true, codePreview: true') && !adminPayments.includes('codeHash: true'), 'admin payments GET must expose waiver codePreview but never codeHash')
  assert(!adminPayments.includes('code: true') && !adminPayments.includes('code,'), 'admin payments GET must never expose a raw waiver code field')

  const admissions = file('src/app/api/admin/admissions/route.ts')
  assert(admissions.includes("sp.get('includeDemo') !== '1'") && admissions.includes('AACT-2026-DEMO-VC') && admissions.includes('demo.thesis@student.aact.academy'), 'admin admissions must hide demo thesis records by default')
  const demoThesis = file('src/app/api/admin/demo-thesis/route.ts')
  assert(demoThesis.includes('ENABLE_DEMO_THESIS') && demoThesis.includes("process.env.VERCEL_ENV !== 'production'"), 'demo thesis seeding must be disabled in production unless explicitly enabled')

  const admissionAi = file('src/lib/admission-ai.ts')
  assert(admissionAi.includes('onlyVisionUnavailable') && admissionAi.includes("else if (onlyVisionUnavailable) verdict = 'NEEDS_CLARIFICATION'"), 'vision-reader failures for all uploaded files must require clarification rather than rejection')
  assert(admissionAi.includes("status: 'MISSING'") && admissionAi.includes('hardProblems++'), 'truly missing required documents must remain hard problems')
  assert(admissionAi.includes("args.unverifiableRequired === 0") && admissionAi.includes('unverified === 0') && admissionAi.includes("verdict = 'RECOMMEND_APPROVE'"), 'unreadable/unverified attachments must never auto-approve')
}

function testSecurityBatchA() {
  const loginRoute = file('src/app/api/auth/login/route.ts')
  assert(!loginRoute.includes('token,'), 'login response must not return a token field')
  assert(loginRoute.includes("user: { id: user.id, name: user.name, email: user.email, role: user.role }"), 'login response must still return the user object')

  const store = file('src/lib/store.ts')
  assert(!store.includes('Authorization: `Bearer'), 'client API helper must not send browser-stored bearer tokens')
  assert(!store.includes('window.localStorage, TOKEN_KEY') && !store.includes('window.sessionStorage, TOKEN_KEY'), 'client store must not read/write auth tokens in browser storage')

  const page = file('src/app/page.tsx')
  assert(!page.includes('saveToken(') && !page.includes('getToken()'), 'page bootstrap must not persist or read auth tokens')
  const authView = file('src/components/aact/AuthView.tsx')
  assert(!authView.includes('saveToken') && authView.includes("api<{ user: any }>('/api/auth/login'"), 'auth view must rely on HttpOnly cookie login')

  const prismaDeploy = file('scripts/prisma-deploy.ts')
  assert(prismaDeploy.includes("process.env.VERCEL_ENV !== 'production'") && prismaDeploy.includes("console.log('skipped')"), 'prisma deploy build hook must skip outside production')
  assert(prismaDeploy.includes("args.has('--push')") && prismaDeploy.includes("args.has('--force-push')") && prismaDeploy.includes('mutatesDatabase'), 'prisma deploy must skip --push and --force-push outside production')
  const officialAiMigration = file('scripts/migrate-official-ai-settings.ts')
  assert(officialAiMigration.includes("if (!isProductionDeployment())") && officialAiMigration.includes("console.log('skipped')"), 'official AI settings migration must skip outside production')
  const vercelSetup = file('scripts/vercel-production-setup.ts')
  assert(vercelSetup.includes("process.env.VERCEL_ENV !== 'production'") && vercelSetup.includes("console.log('skipped')"), 'Vercel production setup must skip outside production')

  const vercel = JSON.parse(file('vercel.json'))
  assert(Array.isArray(vercel.regions) && vercel.regions.includes('fra1'), 'vercel.json must pin the fra1 region')

  const emailVerification = file('src/lib/email-verification.ts')
  assert(emailVerification.includes('process.env.NEXT_PUBLIC_APP_URL') && !emailVerification.includes('x-forwarded-host') && !emailVerification.includes("req.headers.get('host')"), 'email verification URLs must use NEXT_PUBLIC_APP_URL only')
  const verifyEmailRoute = file('src/app/api/auth/verify-email/route.ts')
  assert(verifyEmailRoute.includes('process.env.NEXT_PUBLIC_APP_URL') && !verifyEmailRoute.includes('x-forwarded-host') && !verifyEmailRoute.includes("headers.get('host')"), 'verify-email redirects must use NEXT_PUBLIC_APP_URL only')
  const googleRoute = file('src/app/api/auth/google/route.ts')
  assert(googleRoute.includes('process.env.NEXT_PUBLIC_APP_URL') && !googleRoute.includes('x-forwarded-host') && !googleRoute.includes("headers.get('host')"), 'Google OAuth start must use NEXT_PUBLIC_APP_URL only')
  const googleCallback = file('src/app/api/auth/google/callback/route.ts')
  assert(googleCallback.includes('process.env.NEXT_PUBLIC_APP_URL') && !googleCallback.includes('x-forwarded-host') && !googleCallback.includes("headers.get('host')"), 'Google OAuth callback must use NEXT_PUBLIC_APP_URL only')

  const adminBooks = file('src/app/api/admin/books/route.ts')
  assert(adminBooks.includes("parsed.protocol !== 'https:'"), 'admin book links must require HTTPS')
  assert(adminBooks.includes("lookup(parsed.hostname") && adminBooks.includes('isPrivateIp(record.address)'), 'admin book links must reject internal IPs after DNS lookup through the shared storage guard')
  assert(!adminBooks.includes('function isBlockedBookLinkIp'), 'admin book links must not duplicate private IP logic')
  assert(isPrivateIp('0.0.0.0') && isPrivateIp('100.64.0.1') && isPrivateIp('224.0.0.1'), 'shared private IP guard must block 0/8, carrier-grade NAT, and multicast addresses')
  assert(adminBooks.includes("redirect: 'manual'"), 'admin book link fetch must not auto-follow redirects')
  assert(adminBooks.includes('readResponseBufferWithLimit(res, MAX_BOOK_SIZE)'), 'admin book link fetch must enforce a maximum response size')

  const payments = file('src/app/api/payments/route.ts')
  assert(payments.includes("const isPrivileged = user.role === 'ADMIN'") && !payments.includes("user.role === 'ADMIN' || user.role === 'SUPERVISOR'"), 'payments privileged access must be ADMIN-only')
}

async function main() {
  testDeadlineMath()
  testProductionFixtureGuards()
  testWorkflowTargetsQaOnly()
  testFinallyCleanup()
  testPrivateStoragePolicy()
  await testFileAccessPolicyBehavior()
  testOfficialSettingsDeploymentHook()
  testAiDeadlines()
  testGradingCertificateFlowRegressions()
  testWhatsAppMinimalSafety()
  testAactTestRecipientBlocks()
  testDependencyPins()
  testPrismaDeployPreviewPushSkips()
  testSecurityBatchA()
  console.log('✓ production safety behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
