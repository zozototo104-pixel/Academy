import { readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest } from 'next/server'
import {
  hasAactTestRecipient,
  isAactTestEmail,
  isPrivateStorageKey,
  qaProdFixturesAllowed,
  remainingDeadlineMs,
  unsignedWebhookTestsAllowed,
} from '../src/lib/prod-safety'
import { canAccessStorageKeyWithClient } from '../src/lib/file-access-policy'
import { __handleFileGetForTests } from '../src/app/api/files/[...key]/route'
import { DEFAULT_OFFICIAL_CONTACT } from '../src/lib/settings'
import { resolveWhatsAppDirectSettingsReply } from '../src/lib/whatsapp-cloud'
import { __handleWhatsAppPostForTests, processStaleWhatsAppInboundEvents } from '../src/app/api/webhooks/whatsapp/route'
import { GET as whatsappRetryCronGET } from '../src/app/api/cron/whatsapp-retry/route'
import { platformPublicAgentComplete } from '../src/lib/platform-agent'

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
  const assignments = file('src/app/api/assignments/route.ts')
  assert(assignments.includes('getStorageDownloadPathForKey(submission.fileStorageKey)'), 'student assignment files must expose protected file URLs')
  const thesis = file('src/app/api/thesis/route.ts')
  assert(thesis.includes('getStorageDownloadPathForKey(thesis.fileStorageKey)'), 'student thesis files must expose protected file URLs')
  const adminAssignments = file('src/app/api/admin/assignments/route.ts')
  assert(adminAssignments.includes('getStorageDownloadPathForKey(s.fileStorageKey)'), 'admin assignment submissions must expose protected file URLs')
  const adminThesis = file('src/app/api/admin/thesis/route.ts')
  assert(adminThesis.includes('getStorageDownloadPathForKey(fileStorageKey)'), 'admin thesis file URLs must be protected')
  assert(adminThesis.includes('getStorageDownloadPathForKey(recordingStorageKey)'), 'admin thesis recording URLs must be protected')
  const deliverables = file('src/app/api/service-deliverables/route.ts')
  assert(deliverables.includes('getStorageDownloadPathForKey(storageKey)'), 'service deliverables must expose protected file URLs')
  const adminBooks = file('src/components/aact/AdminBooks.tsx')
  assert(adminBooks.includes('s.fileUrl || s.downloadUrl'), 'admin assignment inline list must display protected file URLs')
  assert(adminBooks.includes('submission.fileUrl || submission.downloadUrl'), 'admin assignment grading cards must display protected file URLs')
  assert(adminBooks.includes('gradingDialog.submission.fileUrl || gradingDialog.submission.downloadUrl'), 'admin assignment grading dialog must display protected file URLs')
  const adminExtras = file('src/components/aact/AdminExtras.tsx')
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
  const whatsappRoute = file('src/app/api/webhooks/whatsapp/route.ts')
  assert(whatsappRoute.includes('export const maxDuration = 60'), 'WhatsApp route must export maxDuration')
  assert(whatsappRoute.includes('const deadlineMs = Date.now() + MESSAGE_PROCESSING_BUDGET_MS'), 'WhatsApp route must create one processing deadline')
}

function testAactTestRecipientBlocks() {
  assert(isAactTestEmail('student@aact.test'), 'aact.test address must be detected')
  assert(isAactTestEmail('QA Student <student@aact.test>'), 'aact.test display-name address must be detected')
  assert(hasAactTestRecipient('Admin <admin@example.com>; QA Student <student@aact.test>'), 'display-name recipient lists must be blocked')
}

function makeWhatsAppWebhookMockDb() {
  const events = new Map<string, any>()
  const byMessage = new Map<string, string>()
  let nextId = 1
  return {
    events,
    byMessage,
    db: {
      whatsAppInboundEvent: {
        create: async (args: any) => {
          const messageId = args.data.waMessageId
          if (byMessage.has(messageId)) {
            const error: any = new Error('Unique constraint failed on waMessageId')
            error.code = 'P2002'
            throw error
          }
          const id = `event-${nextId++}`
          const row = { id, ...args.data, attempts: 0, updatedAt: new Date(Date.now() - 120_000) }
          events.set(id, row)
          byMessage.set(messageId, id)
          return { id }
        },
        findUnique: async (args: any) => {
          const id = args.where?.id || byMessage.get(args.where?.waMessageId)
          return id ? events.get(id) || null : null
        },
      },
      auditLog: { create: async () => ({ id: 'audit-1' }) },
    },
  }
}

async function testWhatsAppWebhookHandlerBehavior() {
  const mock = makeWhatsAppWebhookMockDb()
  const afterFns: Array<() => unknown> = []
  const processed: string[] = []
  const message = { id: 'wamid.1', from: '970599000001', text: 'أريد معرفة البرامج', phoneNumberId: 'phone-1', rawType: 'text', originKind: 'TEXT' as const }
  const req = () => new NextRequest('https://academy.test/api/webhooks/whatsapp', { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=test' }, body: JSON.stringify({ object: 'whatsapp_business_account' }) })
  const deps = {
    verifyWhatsAppSignature: () => true,
    extractWhatsAppInboundMessages: () => [message],
    db: mock.db,
    after: (fn: () => unknown) => { afterFns.push(fn) },
    processWhatsAppEvent: async (id: string) => { processed.push(id) },
    audit: async () => null,
    officialWhatsAppConfigured: () => true,
    expectedWhatsAppPhoneNumberId: () => 'phone-1',
  }
  const first = await __handleWhatsAppPostForTests(req(), deps)
  assert(first.status === 200, 'WhatsApp webhook handler must acknowledge Meta with 200 after saving the event')
  const firstBody: any = await first.json()
  assert(firstBody.queued === 1 && afterFns.length === 1, 'WhatsApp webhook handler must queue exactly one new event')
  await Promise.resolve(afterFns[0]())
  assert(processed.length === 1, 'WhatsApp webhook after() processor must run once for the saved event')

  const duplicate = await __handleWhatsAppPostForTests(req(), deps)
  const duplicateBody: any = await duplicate.json()
  assert(duplicate.status === 200 && duplicateBody.queued === 0 && duplicateBody.duplicates === 1, 'two requests for the same WhatsApp message must not queue a second reply')
  assert(processed.length === 1, 'duplicate WhatsApp messages must not send two replies')

  const oldCronSecret = process.env.CRON_SECRET
  const oldVercelCronSecret = process.env.VERCEL_CRON_SECRET
  delete process.env.CRON_SECRET
  delete process.env.VERCEL_CRON_SECRET
  const cronDenied = await whatsappRetryCronGET(new NextRequest('https://academy.test/api/cron/whatsapp-retry'))
  assert(cronDenied.status === 401, 'WhatsApp retry cron must fail closed when CRON_SECRET is missing')
  if (oldCronSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = oldCronSecret
  if (oldVercelCronSecret === undefined) delete process.env.VERCEL_CRON_SECRET
  else process.env.VERCEL_CRON_SECRET = oldVercelCronSecret
}

async function testWhatsAppPublicAgentWithMocks() {
  let lastProvider = 'GEMINI'
  let routerCalls = 0
  let providerHealthCalls = 0
  const fallbackResult = await platformPublicAgentComplete({
    messages: [{ role: 'user', content: 'أريد معلومات عن شروط القبول في الأكاديمية' }],
    channel: 'WHATSAPP',
    deadlineMs: Date.now() + 30_000,
    getProviderHealth: async () => {
      providerHealthCalls += 1
      return [{ provider: 'OPENAI', model: 'openai-mock', status: 'شغّال', health: { ok: true, checkedAt: new Date().toISOString() } }]
    },
    __testDeps: {
      analyzeConversationIntent: async () => ({ intent: 'ADMISSION', confidence: 0.9, suggestedAgent: 'ADMISSIONS', raw: '' } as any),
      textAiComplete: async (opts: any) => {
        routerCalls += 1
        if (routerCalls === 1) {
          lastProvider = 'GEMINI'
          throw new Error('Gemini mock failure')
        }
        assert(Array.isArray(opts.excludeProviders) && opts.excludeProviders.includes('GEMINI'), 'WhatsApp router retry must exclude the failed provider')
        lastProvider = 'OPENAI'
        return 'رد من مزود بديل بدون رد احتياطي'
      },
      textAiDiagnostics: async () => ({ lastResult: { provider: lastProvider, model: `${lastProvider.toLowerCase()}-mock`, error: lastProvider === 'GEMINI' ? 'Gemini mock failure' : undefined } } as any),
    },
  } as any)
  assert(providerHealthCalls === 1, 'WhatsApp alternate-provider retry must consult provider health')
  assert(routerCalls === 2, 'Gemini failure must trigger exactly one alternate-provider router retry')
  assert(fallbackResult.reply.includes('رد من مزود بديل'), 'alternate provider must deliver the WhatsApp reply')
  assert(!fallbackResult.reply.includes('المساعد غير متاح حالياً'), 'alternate-provider success must not send fallback unavailable text')

  let classifierCalls = 0
  let rulesRouterCalls = 0
  const classifierFailureResult = await platformPublicAgentComplete({
    messages: [{ role: 'user', content: 'ما شروط القبول في برامج التدريب؟' }],
    channel: 'WHATSAPP',
    deadlineMs: Date.now() + 30_000,
    __testDeps: {
      analyzeConversationIntent: async () => {
        classifierCalls += 1
        throw new Error('classifier timeout')
      },
      textAiComplete: async () => {
        rulesRouterCalls += 1
        return 'وصل الرد بعد فشل المصنف عبر القواعد والراوتر'
      },
      textAiDiagnostics: async () => ({ lastResult: { provider: 'OPENAI', model: 'openai-mock' } } as any),
    },
  } as any)
  assert(classifierCalls === 1, 'classifier mock must be invoked once')
  assert(rulesRouterCalls === 1, 'classifier failure must continue to the rules/router flow')
  assert(classifierFailureResult.reply.includes('وصل الرد بعد فشل المصنف'), 'reply must be delivered after classifier failure')
}

async function testWhatsAppRetryCronProcessesStaleEventsOnce() {
  const now = Date.now()
  const rows = new Map<string, any>([
    ['received-1', { id: 'received-1', status: 'RECEIVED', attempts: 0, updatedAt: new Date(now - 120_000) }],
    ['failed-1', { id: 'failed-1', status: 'FAILED', attempts: 1, updatedAt: new Date(now - 120_000) }],
  ])
  const processed: string[] = []
  const dbMock = {
    whatsAppInboundEvent: {
      findMany: async () => [...rows.values()]
        .filter((row) => ['RECEIVED', 'FAILED'].includes(row.status) && row.attempts < 2 && row.updatedAt.getTime() < now - 60_000)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .map((row) => ({ id: row.id })),
    },
  }
  const processor = async (id: string) => {
    const row = rows.get(id)
    if (!row || !['RECEIVED', 'FAILED'].includes(row.status)) return
    processed.push(id)
    row.status = 'DONE'
    row.attempts += 1
    row.updatedAt = new Date(now)
  }
  const first = await processStaleWhatsAppInboundEvents(20, { db: dbMock, processWhatsAppEvent: processor, now: () => now })
  const second = await processStaleWhatsAppInboundEvents(20, { db: dbMock, processWhatsAppEvent: processor, now: () => now })
  assert(first.processed === 2, 'WhatsApp retry cron must process old RECEIVED and FAILED events')
  assert(second.processed === 0, 'calling WhatsApp retry cron twice must not process the same event twice')
  assert(processed.join(',') === 'received-1,failed-1', 'each stale WhatsApp event must be processed exactly once')
}

async function testWhatsAppReliabilityBehavior() {
  const faqDeps = {
    getSettings: async () => ({ FEE_APPLICATION: '30', FEE_DIPLOMAS_MIN: '100', FEE_DIPLOMAS_MAX: '350', FEE_MASTERS: '700', FEE_DOCTORATE: '1300', PAYMENT_MODE: 'DIRECT_PAYMENT' }),
    getOfficialContact: async () => DEFAULT_OFFICIAL_CONTACT,
    listPrograms: async () => [],
  }
  const feesReply = await resolveWhatsAppDirectSettingsReply('كم رسوم الماجستير؟', faqDeps)
  assert(Boolean(feesReply?.includes('700$') && feesReply.includes('رسوم التقديم')), 'WhatsApp fee questions must be answered from settings without AI')
  const paymentReply = await resolveWhatsAppDirectSettingsReply('ما هي طرق الدفع؟', faqDeps)
  assert(Boolean(paymentReply?.includes('طرق الدفع') && paymentReply.includes('DIRECT_PAYMENT')), 'WhatsApp payment questions must be answered from settings without AI')

  const platformAgent = file('src/lib/platform-agent.ts')
  assert(platformAgent.includes("taskLevel: 'GENERAL'"), 'WhatsApp visitor replies must use GENERAL task level')
  assert(platformAgent.includes("purpose: 'CHAT'"), 'WhatsApp visitor replies must use chat/general router purpose')
  assert(platformAgent.includes('return await runWhatsAppRouter()'), 'WhatsApp public replies must go through the full text AI router rather than Gemini direct')
  assert(platformAgent.includes('runWhatsAppRouter([failedProvider])'), 'WhatsApp public replies must try one alternate healthy provider when time remains')
  assert(platformAgent.includes('Date.now() + 4_000'), 'WhatsApp intent classifier deadline must be at most four seconds')
  assert(platformAgent.includes('Date.now() + Math.min(20_000'), 'WhatsApp provider deadline must be at most twenty seconds')
  assert(platformAgent.includes('continuing with local routing rules'), 'WhatsApp classifier failure must continue with local rules')

  const whatsappRoute = file('src/app/api/webhooks/whatsapp/route.ts')
  assert(whatsappRoute.includes("{ status: 'RECEIVED', attempts: { lt: 2 } }"), 'WhatsApp event claim must cap RECEIVED retries at two attempts')
  assert(whatsappRoute.includes("{ status: 'FAILED', attempts: { lt: 2 } }"), 'WhatsApp event claim must cap FAILED retries at two attempts')
  assert(whatsappRoute.includes('processStaleWhatsAppInboundEvents'), 'WhatsApp stale-event cron processor must exist')
  assert(whatsappRoute.includes('provider: meta.provider'), 'WhatsApp fallback audit must include provider')
  assert(whatsappRoute.includes('classifierResult: meta.classifierResult'), 'WhatsApp fallback audit must include classifier result')

  const cron = file('src/app/api/cron/whatsapp-retry/route.ts')
  assert(cron.includes('processStaleWhatsAppInboundEvents(20)'), 'WhatsApp cron must pick up stale events')
  const vercel = file('vercel.json')
  assert(vercel.includes('/api/cron/whatsapp-retry') && vercel.includes('* * * * *'), 'WhatsApp retry cron must run every minute')

  const failuresApi = file('src/app/api/admin/whatsapp-failures/route.ts')
  assert(failuresApi.includes("action: 'WHATSAPP_AI_FALLBACK_SENT'"), 'admin failures API must read fallback audit logs')
  assert(failuresApi.includes('take: 50'), 'admin failures API must return the latest 50 records')
  const adminView = file('src/components/aact/AdminView.tsx')
  assert(adminView.includes('إخفاقات الواتساب') && adminView.includes('AdminWhatsAppFailuresTab'), 'admin UI must expose WhatsApp failures tab')
}

function testWhatsAppUnsignedWebhookProductionBlock() {
  assert(!unsignedWebhookTestsAllowed({ VERCEL_ENV: 'production', WHATSAPP_ALLOW_UNSIGNED_WEBHOOK_TESTS: '1' } as any), 'unsigned WhatsApp tests must never be allowed in production')
  assert(unsignedWebhookTestsAllowed({ VERCEL_ENV: 'preview', WHATSAPP_ALLOW_UNSIGNED_WEBHOOK_TESTS: '1' } as any), 'unsigned WhatsApp tests may remain available outside production')
  const cloud = file('src/lib/whatsapp-cloud.ts')
  assert(cloud.includes('unsignedWebhookTestsAllowed()'), 'WhatsApp signature verification must use production-safe unsigned-test guard')
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
  await testWhatsAppReliabilityBehavior()
  await testWhatsAppPublicAgentWithMocks()
  await testWhatsAppWebhookHandlerBehavior()
  await testWhatsAppRetryCronProcessesStaleEventsOnce()
  testWhatsAppUnsignedWebhookProductionBlock()
  testDependencyPins()
  console.log('✓ production safety behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
