import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aiRetryDelayMs, parseRetryAfterMs } from '../src/lib/ai-retry'
import { decryptSecret, encryptSecret, isEncryptedSecret, redactSecrets } from '../src/lib/secret-crypto'
import { modelAllowedForPurpose } from '../src/lib/text-ai'

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function testProviderOrderUnchanged() {
  const code = src('src/lib/text-ai.ts')
  const expected = "'GEMINI',\n  'UNOROUTER',\n  'OPENROUTER',\n  'TOPTOOLS',\n  'OPENAI',\n  'ANTHROPIC',\n  'ZAI',\n  'GROQ',\n  'RELAYROUTER',\n  'DEEPINFRA',\n  'TOGETHER',\n  'OPENAI_COMPAT'"
  assert(code.includes(expected), 'AUTO provider order must remain unchanged')
}

function testPurposeVisionCapabilityFiltering() {
  assert.equal(modelAllowedForPurpose('plain-text-model', 'VISION', { vision: false, modalities: ['text'] }), false)
  assert.equal(modelAllowedForPurpose('unknown-capability-model', 'VISION', null), true)
  assert.equal(modelAllowedForPurpose('long-context', 'LONG_CONTEXT', { contextLength: 128000 }), true)
  assert.equal(modelAllowedForPurpose('short-context', 'LONG_CONTEXT', { contextLength: 8192 }), false)
}

function testHealthFallbackAndStreamGuardPresent() {
  const textAi = src('src/lib/text-ai.ts')
  assert(textAi.includes('recentFailedHealth'), 'router must skip recent failed model health checks')
  assert(textAi.includes('healthFilteredModels.length ? healthFilteredModels : orderedModels'), 'router must fall back to normal order if every model is health-skipped')
  const gemini = src('src/lib/gemini.ts')
  assert(gemini.includes('emittedAnyChunk'), 'streaming must track first emitted chunk')
  assert(gemini.includes('انقطع الرد، أعد المحاولة'), 'streaming must end with retry message after post-chunk failure')
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

function testAcademicVerifierExcludesGeneratorProvider() {
  const verifier = src('src/lib/question-verifier.ts')
  assert(verifier.includes('excludeProviders'), 'question verifier must keep excluding generator provider')
  assert(verifier.includes("purpose: 'REVIEW'"), 'purpose routing must not remove cross-provider verifier exclusion')
}

for (const fn of [testProviderOrderUnchanged, testPurposeVisionCapabilityFiltering, testHealthFallbackAndStreamGuardPresent, testRetryAfter, testSecretCryptoAndRedaction, testAcademicVerifierExcludesGeneratorProvider]) {
  fn()
  console.log(`✓ ${fn.name}`)
}
