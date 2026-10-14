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
import { getStorageDownloadPathForKey } from '../src/lib/storage'
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

function testAactTestRecipientBlocks() {
  assert(isAactTestEmail('student@aact.test'), 'aact.test address must be detected')
  assert(isAactTestEmail('QA Student <student@aact.test>'), 'aact.test display-name address must be detected')
  assert(hasAactTestRecipient('Admin <admin@example.com>; QA Student <student@aact.test>'), 'display-name recipient lists must be blocked')
}

function testDependencyPins() {
  const pkg = JSON.parse(file('package.json'))
  assert(pkg.dependencies.next === '^16.4.0', 'Next.js dependency must be updated')
  assert(pkg.dependencies.react === '^19.3.0', 'React dependency must be updated')
  assert(pkg.dependencies['react-dom'] === '^19.3.0', 'React DOM dependency must be updated')
  assert(pkg.devDependencies['eslint-config-next'] === '^16.4.0', 'eslint-config-next must match Next.js patch')
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
  testAactTestRecipientBlocks()
  testDependencyPins()
  console.log('✓ production safety behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
