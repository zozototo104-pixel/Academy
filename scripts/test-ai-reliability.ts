import assert from 'node:assert/strict'
import { aiRetryDelayMs, parseRetryAfterMs } from '../src/lib/ai-retry'
import { claimAiHealthRun } from '../src/lib/ai-health'
import { streamWithNoFallbackAfterFirstChunk, STREAM_INTERRUPTED_RETRY_MESSAGE } from '../src/lib/ai-stream-guard'
import { __testDecodeGeminiKeySetting } from '../src/lib/gemini'
import { __testVerifierExcludedProviders } from '../src/lib/question-verifier'
import { decryptSecret, encryptSecret, isEncryptedSecret, redactDeep, redactSecrets } from '../src/lib/secret-crypto'
import { __testApplyRecentFailedHealthSkip, __testDecryptTextAiSettingValue, __testPrimaryProviderOrder, modelAllowedForPurpose } from '../src/lib/text-ai'

async function collect(iterable: AsyncIterable<string>) {
  const out: string[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function asyncChunks(chunks: string[], failAfter = false): () => AsyncIterable<string> {
  return async function* () {
    for (const chunk of chunks) yield chunk
    if (failAfter) throw new Error('mock stream failure sk-test-secret-123456')
  }
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

async function testStreamingNoFallbackAfterChunksBehavior() {
  let fallbackCalls = 0
  const chunks = await collect(streamWithNoFallbackAfterFirstChunk(
    asyncChunks(['chunk-1', 'chunk-2'], true),
    () => {
      fallbackCalls += 1
      return asyncChunks(['fallback-should-not-run'])()
    },
  ))
  assert.deepEqual(chunks, ['chunk-1', 'chunk-2', STREAM_INTERRUPTED_RETRY_MESSAGE])
  assert.equal(fallbackCalls, 0)
}

function testHealthAllFailedFallsBackToNormalBehavior() {
  const ordered = ['m1', 'm2', 'm3']
  assert.deepEqual(__testApplyRecentFailedHealthSkip(ordered, ['m1', 'm2', 'm3']), ordered)
  assert.deepEqual(__testApplyRecentFailedHealthSkip(ordered, ['m1']), ['m2', 'm3'])
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

function testRedactDeepNestedObjects() {
  const redacted = redactDeep({
    a: 'sk-abcdefghijklmnop',
    nested: [{ b: 'AIza12345678901234567890' }, { c: 'Bearer abcdefghijklmnop' }],
  })
  const serialized = JSON.stringify(redacted)
  assert(!serialized.includes('sk-abcdefghijklmnop'))
  assert(!serialized.includes('AIza12345678901234567890'))
  assert(!serialized.includes('Bearer abcdefghijklmnop'))
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

function testAcademicVerifierExcludesGeneratorProviderBehavior() {
  assert.deepEqual(__testVerifierExcludedProviders('GEMINI'), ['GEMINI'])
  assert(!__testVerifierExcludedProviders('GEMINI').includes('OPENAI'))
}

async function testAiHealthClaimIsAtomicBehavior() {
  let stored = ''
  const mockClient = {
    async $queryRawUnsafe(_query: string, nowValue: unknown, cutoffValue: unknown) {
      const current = /^\d+$/.test(stored) ? Number(stored) : 0
      if (current < Number(cutoffValue)) {
        stored = String(nowValue)
        return [{ key: 'AI_HEALTH_LAST_RUN' }]
      }
      return []
    },
  }
  assert.equal(await claimAiHealthRun(mockClient, 10_000_000), true)
  assert.equal(await claimAiHealthRun(mockClient, 10_000_001), false)
}

function testAdminSystemGetShapeDoesNotExposeSecretsBehavior() {
  process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 13).toString('base64')
  const original = 'sk-admin-secret-abcdefghijkl'
  const encrypted = encryptSecret(original)
  const body = redactDeep({ values: { OPENAI_API_KEY: 'ope••••••cdef' }, secretMeta: { OPENAI_API_KEY: { hasValue: true, last4: original.slice(-4), encrypted: true, source: 'settings' } }, raw: encrypted, original })
  const serialized = JSON.stringify(body)
  assert(!serialized.includes(original))
  assert(!serialized.includes(encrypted))
  assert(serialized.includes(original.slice(-4)))
  delete process.env.AACT_SECRETS_KEY
}

async function main() {
  const tests: Array<() => void | Promise<void>> = [
    testProviderOrderUnchanged,
    testPurposeVisionCapabilityFiltering,
    testStreamingNoFallbackAfterChunksBehavior,
    testHealthAllFailedFallsBackToNormalBehavior,
    testRetryAfter,
    testSecretCryptoAndRedaction,
    testRedactDeepNestedObjects,
    testGeminiEncryptedSettingDecryptsToOriginalKey,
    testPlaintextGatewaySettingsRejectedBehaviorally,
    testAcademicVerifierExcludesGeneratorProviderBehavior,
    testAiHealthClaimIsAtomicBehavior,
    testAdminSystemGetShapeDoesNotExposeSecretsBehavior,
  ]
  for (const fn of tests) {
    await fn()
    console.log(`✓ ${fn.name}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
