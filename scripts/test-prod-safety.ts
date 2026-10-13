import { readFileSync } from 'fs'
import { join } from 'path'
import {
  hasAactTestRecipient,
  isAactTestEmail,
  isPrivateStorageKey,
  qaProdFixturesAllowed,
  unsignedWebhookTestsAllowed,
} from '../src/lib/prod-safety'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
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
  ]) {
    assert(isPrivateStorageKey(key), `${key} must be classified as private`)
  }
  assert(!isPrivateStorageKey('public/catalog.pdf'), 'public catalog key must not be classified as private')

  const storage = file('src/lib/storage.ts')
  assert(storage.includes('if (isPrivateStorageKey(cleanKey)) return null'), 'private storage keys must never receive public URLs')
  assert(storage.includes('getStorageDownloadPathForKey'), 'private upload result must point to controlled download route')

  const adminPayments = file('src/app/api/admin/payments/route.ts')
  assert(adminPayments.includes('secureProofPayload'), 'admin payment proofs must rewrite private storage URLs to the controlled file route')

  const route = file('src/app/api/files/[...key]/route.ts')
  assert(route.includes('const SIGNED_URL_TTL_SECONDS = 5 * 60'), 'file route must issue 5-minute signed URLs')
  assert(route.includes('user.role === \'ADMIN\''), 'file route must allow admins')
  assert(route.includes('admissionDocument'), 'file route must authorize admission document owners')
  assert(route.includes('paymentProof'), 'file route must authorize payment proof owners')
  assert(route.includes('assignmentSubmission'), 'file route must authorize assignment owners')
  assert(route.includes('thesisSubmission'), 'file route must authorize thesis owners')
  assert(route.includes('backups/'), 'file route must treat backups as admin-only private files')
}

function testOfficialSettingsDeploymentHook() {
  const pkg = JSON.parse(file('package.json'))
  const build = String(pkg.scripts?.build || '')
  assert(build.includes('tsx scripts/prisma-deploy.ts && tsx scripts/migrate-official-ai-settings.ts'), 'official AI settings migration must run immediately after prisma deploy')
  assert(pkg.scripts?.['settings:migrate:official-ai'] === 'tsx scripts/migrate-official-ai-settings.ts', 'package.json must expose official settings migration script')

  const migration = file('scripts/migrate-official-ai-settings.ts')
  assert(migration.includes('if (existing) continue'), 'official settings migration must not overwrite existing values')
}

function testAiDeadlines() {
  const chat = file('src/app/api/chat/route.ts')
  assert(chat.includes('export const maxDuration = 60'), 'chat route must export maxDuration')
  assert(chat.includes('const deadlineMs = deadlineFromNow(55_000)'), 'chat route must create one shared deadline')
  assert(chat.includes('platformAgentComplete({') && chat.includes('deadlineMs,'), 'chat route must pass deadline to completion chain')
  assert(chat.includes('platformAgentStream({') && chat.includes('deadlineMs,'), 'chat route must pass deadline to streaming chain')

  const platformAgent = file('src/lib/platform-agent.ts')
  assert(platformAgent.includes('deadlineMs?: number'), 'platform agent APIs must accept deadlineMs')
  assert(platformAgent.includes('analyzeConversationIntent(opts.messages') && platformAgent.includes('deadlineMs: opts.deadlineMs'), 'classifier must receive the same deadline')
  assert(platformAgent.includes('remainingDeadlineMs(opts.deadlineMs'), 'providers/fallbacks must use remaining shared deadline')

  const whatsappRoute = file('src/app/api/webhooks/whatsapp/route.ts')
  assert(whatsappRoute.includes('export const maxDuration = 60'), 'WhatsApp route must export maxDuration')
  assert(whatsappRoute.includes('const deadlineMs = Date.now() + MESSAGE_PROCESSING_BUDGET_MS'), 'WhatsApp route must create one processing deadline')
  assert(whatsappRoute.includes('resolveWhatsAppBotReply(inboundMessage, storedInbound, deadlineMs)'), 'WhatsApp route must pass deadline to bot reply')
}

function testAactTestRecipientBlocks() {
  assert(isAactTestEmail('student@aact.test'), 'aact.test address must be detected')
  assert(hasAactTestRecipient('admin@example.com, student@aact.test'), 'mixed recipient list must be blocked')

  const mailer = file('src/lib/mailer.ts')
  assert(mailer.includes('hasAactTestRecipient(input.to)'), 'mailer must block aact.test recipients before provider calls')
  assert(mailer.includes('AACT_TEST_RECIPIENT_BLOCKED'), 'blocked test email should be logged as skipped')

  const notify = file('src/lib/notify.ts')
  assert(notify.includes('isAactTestEmail(user?.email)'), 'notifications must skip aact.test users')
}

function testWhatsAppUnsignedWebhookProductionBlock() {
  assert(!unsignedWebhookTestsAllowed({ VERCEL_ENV: 'production', WHATSAPP_ALLOW_UNSIGNED_WEBHOOK_TESTS: '1' } as any), 'unsigned WhatsApp tests must never be allowed in production')
  assert(unsignedWebhookTestsAllowed({ VERCEL_ENV: 'preview', WHATSAPP_ALLOW_UNSIGNED_WEBHOOK_TESTS: '1' } as any), 'unsigned WhatsApp tests may remain available outside production')

  const cloud = file('src/lib/whatsapp-cloud.ts')
  assert(cloud.includes('unsignedWebhookTestsAllowed()'), 'WhatsApp signature verification must use production-safe unsigned-test guard')
}

function testDependencyPins() {
  const pkg = JSON.parse(file('package.json'))
  assert(pkg.dependencies.next === '^16.3.4', 'Next.js dependency must be updated')
  assert(pkg.dependencies.react === '^19.2.8', 'React dependency must be updated')
  assert(pkg.dependencies['react-dom'] === '^19.2.8', 'React DOM dependency must be updated')
  assert(pkg.devDependencies['eslint-config-next'] === '^16.3.4', 'eslint-config-next must match Next.js patch')

  const lock = file('bun.lock')
  assert(lock.includes('"next": "^16.3.4"'), 'bun.lock workspace dependency must include updated Next.js range')
  assert(lock.includes('"react": "^19.2.8"'), 'bun.lock workspace dependency must include updated React range')
  assert(lock.includes('"react-dom": "^19.2.8"'), 'bun.lock workspace dependency must include updated React DOM range')
}

testProductionFixtureGuards()
testWorkflowTargetsQaOnly()
testFinallyCleanup()
testPrivateStoragePolicy()
testOfficialSettingsDeploymentHook()
testAiDeadlines()
testAactTestRecipientBlocks()
testWhatsAppUnsignedWebhookProductionBlock()
testDependencyPins()

console.log('✓ production safety behavioral checks passed')
