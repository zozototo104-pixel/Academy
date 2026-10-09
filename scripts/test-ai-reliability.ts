import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aiRetryDelayMs, parseRetryAfterMs } from '../src/lib/ai-retry'
import { __testDecodeGeminiKeySetting } from '../src/lib/gemini'
import { decryptSecret, encryptSecret, isEncryptedSecret, redactSecrets } from '../src/lib/secret-crypto'
import { __testDecryptTextAiSettingValue, __testPrimaryProviderOrder, modelAllowedForPurpose } from '../src/lib/text-ai'

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function testProviderOrderUnchanged() {
  assert.deepEqual(__testPrimaryProviderOrder(), [
    'GEMINI',
    'UNOROUTER',
    'OPENROUTER',
    'TOPTOOLS',
    'OPENAI',
    'ANTHROPIC',
    'ZAI',
    'GROQ',
    'RELAYROUTER',
    'DEEPINFRA',
    'TOGETHER',
    'OPENAI_COMPAT',
  ])
}

function testPurposeVisionCapabilityFiltering() {
  assert.equal(modelAllowedForPurpose('plain-text-model', 'VISION', { vision: false, modalities: ['text'] }), false)
  assert.equal(modelAllowedForPurpose('unknown-capability-model', 'VISION', null), true)
  assert.equal(modelAllowedForPurpose('long-context', 'LONG_CONTEXT', { contextLength: 128000 }), true)
  assert.equal(modelAllowedForPurpose('short-context', 'LONG_CONTEXT', { contextLength: 8192 }), false)
}

function testFailedHealthFallbackAndStreamGuard() {
  const textAi = src('src/lib/text-ai.ts')
  assert(textAi.includes('healthFilteredModels.length ? healthFilteredModels : orderedModels'), 'router must fall back to normal order if every model is health-skipped')
  const gemini = src('src/lib/gemini.ts')
  assert(gemini.includes('emittedExternalChunk'), 'external streaming path must track first emitted chunk')
  assert(gemini.includes('emittedAnyChunk'), 'native Gemini streaming path must track first emitted chunk')
  assert(gemini.match(/انقطع الرد، أعد المحاولة/g)?.length || 0 >= 2, 'streaming must end with retry message after post-chunk failure')
}

function testRetryAfter() {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(parseRetryAfterMs('2', now), 2000)
  assert.equal(aiRetryDelayMs(0, { retryAfter: '2', nowMs: now, deadlineMs: now + 5000, jitterRatio: 0 }), 2000)
  assert.equal(aiRetryDelayMs(0, { retryAfter: '10', nowMs: now, deadlineMs: now + 5000, jitterRatio: 0 }), null)
}

function testSecretCryptoAndRedaction() {
  process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
  const enc = encryptSecret('sk-test-secret-123456')
  assert.equal(isEncryptedSecret(enc), true)
  assert.equal(decryptSecret(enc), 'sk-test-secret-123456')
  assert(!redactSecrets('token sk-test-secret-123456 Bearer abcdefghijklmnop AIza12345678901234567890').includes('sk-test-secret-123456'))
  delete process.env.AACT_SECRETS_KEY
}

function testGeminiEncryptedSettingDecryptsToOriginalKey() {
  process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64')
  const encrypted = encryptSecret('AIza-real-gemini-key-123456')
  assert.deepEqual(__testDecodeGeminiKeySetting(encrypted), ['AIza-real-gemini-key-123456'])
  assert.deepEqual(__testDecodeGeminiKeySetting('enc:v1:bad'), [])
  delete process.env.AACT_SECRETS_KEY
}

function testPlaintextGatewaySettingsRejectedBehaviorally() {
  assert.equal(__testDecryptTextAiSettingValue('GROQ_API_KEY', 'gsk_plain'), '')
  assert.equal(__testDecryptTextAiSettingValue('OPENROUTER_API_KEYS', 'sk-or-plain'), '')
  assert.equal(__testDecryptTextAiSettingValue('GEMINI_API_KEY', 'AIza-legacy-plain'), 'AIza-legacy-plain')
  process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 11).toString('base64')
  const encrypted = encryptSecret('gsk-encrypted')
  assert.equal(__testDecryptTextAiSettingValue('GROQ_API_KEY', encrypted), 'gsk-encrypted')
  delete process.env.AACT_SECRETS_KEY
}

function testAcademicVerifierExcludesGeneratorProvider() {
  const verifier = src('src/lib/question-verifier.ts')
  assert(!verifier.includes('sameProviderVerifierFallback'), 'question verifier must not include same-provider fallback')
  assert(verifier.includes('const excludeProviders = [opts.generatorProvider as TextAiProvider]'), 'question verifier must exclude generator provider')
  assert(verifier.includes("purpose: 'REVIEW'"), 'purpose routing must not remove cross-provider verifier exclusion')
}

function testAdminGetAndSaveSecretsGuardrails() {
  const system = src('src/app/api/admin/system/route.ts')
  assert(system.includes('shouldEncryptSystemKey(r.key) ? mask(r.value) : r.value'), 'GET must mask all secret-like values')
  assert(system.includes('isMaskedSecret(value)') && system.includes('continue'), 'masked or blank secret values must not overwrite existing settings')
  assert(system.includes('أضف AACT_SECRETS_KEY في Vercel أولاً'), 'saving plaintext secrets without encryption key must be rejected')
}

for (const fn of [testProviderOrderUnchanged, testPurposeVisionCapabilityFiltering, testFailedHealthFallbackAndStreamGuard, testRetryAfter, testSecretCryptoAndRedaction, testGeminiEncryptedSettingDecryptsToOriginalKey, testPlaintextGatewaySettingsRejectedBehaviorally, testAcademicVerifierExcludesGeneratorProvider, testAdminGetAndSaveSecretsGuardrails]) {
  fn()
  console.log(`✓ ${fn.name}`)
}
