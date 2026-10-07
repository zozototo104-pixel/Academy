import assert from 'node:assert/strict'
import { textAiComplete } from '../src/lib/text-ai'

type FetchCall = { url: string; init?: RequestInit }

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AI_') || key.endsWith('_API_KEY') || key.endsWith('_API_KEYS')) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
}

async function withMockFetch(handler: (call: FetchCall) => Response | Promise<Response>, run: (calls: FetchCall[]) => Promise<void>) {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
    resetEnv()
  }
}

async function criticalGeminiFailureFallsThroughToUnoRouter() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.UNOROUTER_API_KEY = 'mock-uno-key'
  process.env.OPENROUTER_API_KEY = 'mock-openrouter-key'
  process.env.TOPTOOLS_API_KEY = 'mock-toptools-key'
  process.env.RELAYROUTER_API_KEY = 'mock-relay-key'

  await withMockFetch(
    (call) => {
      if (call.url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429, headers: { 'content-type': 'application/json' } })
      }
      if (call.url.includes('api.unorouter.com') && call.url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b', is_free: true, online: true, type: 'text' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'academic-ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected provider call' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'test' }], taskLevel: 'ACADEMIC_CRITICAL' })
      assert.equal(result, 'academic-ok')
      assert.ok(calls.some((call) => call.url.includes('generativelanguage.googleapis.com')), 'Critical routing should try Gemini first')
      assert.ok(calls.some((call) => call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')), 'Critical routing should fall through to UnoRouter after Gemini quota failure')
      assert.equal(calls.filter((call) => call.url.includes('openrouter.ai') && call.url.includes('/chat/completions')).length, 0, 'Routing should stop once UnoRouter succeeds')
      assert.equal(calls.filter((call) => call.url.includes('top-tools-ai.com') && call.url.includes('/chat/completions')).length, 0, 'Routing should stop once UnoRouter succeeds')
      assert.equal(calls.filter((call) => call.url.includes('relayrouter.io') && call.url.includes('/chat/completions')).length, 0, 'Routing should stop once UnoRouter succeeds')
    }
  )
}

async function generalKeepsExistingGatewayBehavior() {
  process.env.AI_TEXT_PROVIDER = 'UNOROUTER'
  process.env.UNOROUTER_API_KEY = 'mock-uno-key'
  process.env.UNOROUTER_TEXT_MODEL = 'gpt-oss-120b:free'

  await withMockFetch(
    (call) => {
      if (call.url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(call.url)) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'test' }], taskLevel: 'GENERAL' })
      assert.equal(result, 'ok')
      assert.ok(calls.some((call) => call.url.includes('api.unorouter.com')), 'General routing should retain configured gateway behavior')
    }
  )
}

async function invalidAcademicAllowlistIsRejected() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.AI_ACADEMIC_ALLOWLIST = 'OPENROUTER:auto,UNOROUTER:gpt-oss-120b:free'

  await withMockFetch(
    () => new Response('{}', { status: 500 }),
    async (calls) => {
      await assert.rejects(
        () => textAiComplete({ system: 'test', history: [{ role: 'user', text: 'test' }], taskLevel: 'ACADEMIC_CRITICAL' }),
        (error: any) => error?.code === 'AI_ACADEMIC_PROVIDER_UNAVAILABLE'
      )
      assert.equal(calls.length, 0, 'Invalid auto/free allowlist entries must not be called')
    }
  )
}

async function validationRejectionFallsThroughToNextModel() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.GEMINI_TEXT_MODEL = 'gemini-3.8-flash'

  await withMockFetch(
    (call) => {
      if (!call.url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: 'unexpected provider call' } }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      const model = decodeURIComponent(call.url.match(/\/models\/([^:]+):generateContent/)?.[1] || '')
      const content = model === 'gemini-3.8-flash' ? 'weak-output' : 'validated-output'
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await textAiComplete({
        system: 'test',
        history: [{ role: 'user', text: 'test' }],
        taskLevel: 'ACADEMIC_CRITICAL',
        validate: (text) => {
          if (text === 'weak-output') {
            const error: any = new Error('VALIDATION_REJECTED')
            error.code = 'VALIDATION_REJECTED'
            throw error
          }
        },
      })
      assert.equal(result, 'validated-output')
      const geminiCalls = calls.filter((call) => call.url.includes('generativelanguage.googleapis.com'))
      assert.ok(geminiCalls.length >= 2, 'Validation rejection must make the router try another model')
      assert.ok(geminiCalls.some((call) => !call.url.includes('gemini-3.8-flash')), 'A different Gemini model should be attempted after validation rejection')
    }
  )
}

async function main() {
  await criticalGeminiFailureFallsThroughToUnoRouter()
  await generalKeepsExistingGatewayBehavior()
  await invalidAcademicAllowlistIsRejected()
  console.log('academic AI router guardrails: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  globalThis.fetch = originalFetch
  resetEnv()
})
