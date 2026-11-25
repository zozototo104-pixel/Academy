// Comprehensive exam — Tavily search client: parsing, normalization,
// and typed errors against fake HTTP responses. No real network calls.
import { describe, expect, test } from 'bun:test'
import {
  TAVILY_SEARCH_URL,
  searchTavily,
  TavilySearchError,
  type TavilySearchErrorKind,
} from '../../src/lib/tavily-search'

const TAVILY_BODY = {
  query: 'مبادئ المحاسبة',
  answer: 'ملخص مولّد لا نستخدمه كدليل',
  results: [
    {
      title: 'مبادئ المحاسبة — ويكيبيديا',
      url: 'https://ar.wikipedia.org/wiki/محاسبة',
      content: 'المحاسبة هي تسجيل وتبويب وتحليل المعاملات المالية للمنشأة بهدف تقديم معلومات مفيدة لمتخذي القرار.',
      score: 0.92,
      raw_content: 'نص كامل أطول لا نقرأه',
    },
    {
      title: 'الأصول المتداولة',
      url: 'https://example.com/assets',
      content: 'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية.',
      score: 0.81,
    },
  ],
  response_time: 1.23,
  usage: { credits: 1 },
  request_id: 'req-1',
}

function fakeFetch(body: any, status = 200, opts: { jsonThrows?: boolean } = {}) {
  const calls: any[] = []
  const fn = async (url: any, init: any) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.jsonThrows) throw new Error('not json')
        return typeof body === 'function' ? body() : body
      },
      text: async () => JSON.stringify(body),
    }
  }
  return { fn: fn as unknown as typeof fetch, calls }
}

async function expectKind(promise: Promise<unknown>, kind: TavilySearchErrorKind, status?: number) {
  let caught: any = null
  try {
    await promise
  } catch (e: any) {
    caught = e
  }
  expect(caught).toBeInstanceOf(TavilySearchError)
  expect(caught?.kind).toBe(kind)
  if (status !== undefined) expect(caught?.status).toBe(status)
}

describe('searchTavily — happy path and request shape', () => {
  test('normalizes results, credits and response time; sends Bearer auth with basic depth', async () => {
    const { fn, calls } = fakeFetch(TAVILY_BODY)
    const out = await searchTavily({ apiKey: 'tvly-test-key', query: 'مبادئ المحاسبة', maxResults: 10 }, { fetchFn: fn })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(TAVILY_SEARCH_URL)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tvly-test-key')
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    const sent = JSON.parse(calls[0].init.body)
    expect(sent.query).toBe('مبادئ المحاسبة')
    expect(sent.search_depth).toBe('basic')
    expect(sent.max_results).toBe(10)
    expect(sent.include_answer).toBe(false)
    expect(sent.include_usage).toBe(true)
    expect(sent.api_key).toBeUndefined()
    expect(out.query).toBe('مبادئ المحاسبة')
    expect(out.results.length).toBe(2)
    expect(out.results[0]).toEqual({
      title: 'مبادئ المحاسبة — ويكيبيديا',
      url: 'https://ar.wikipedia.org/wiki/محاسبة',
      content: 'المحاسبة هي تسجيل وتبويب وتحليل المعاملات المالية للمنشأة بهدف تقديم معلومات مفيدة لمتخذي القرار.',
      score: 0.92,
    })
    expect(out.creditsUsed).toBe(1)
    expect(out.responseTime).toBe(1.23)
  })

  test('skips rows without url/content; title falls back to the url', async () => {
    const { fn } = fakeFetch({
      query: 'x',
      results: [
        { title: '', url: 'https://example.com/only', content: 'خلاصة كافية بطول مناسب تتجاوز أربعين حرفاً بلا شك.' },
        { title: 'بلا رابط', url: '', content: 'خلاصة بلا رابط.' },
        { title: 'بلا نص', url: 'https://example.com/empty', content: '   ' },
      ],
      usage: {},
    })
    const out = await searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fn })
    expect(out.results.length).toBe(1)
    expect(out.results[0].title).toBe('https://example.com/only')
    expect(out.creditsUsed).toBeNull()
  })

  test('clamps maxResults into the documented 1..20 range', async () => {
    const { fn, calls } = fakeFetch({ query: 'x', results: [] })
    await searchTavily({ apiKey: 'tvly-k', query: 'x', maxResults: 50 }, { fetchFn: fn })
    expect(JSON.parse(calls[0].init.body).max_results).toBe(20)
  })
})

describe('searchTavily — typed errors, never a silent empty result', () => {
  test('empty key is AUTH; empty query is BAD_REQUEST', async () => {
    await expectKind(searchTavily({ apiKey: '', query: 'x' }), 'AUTH')
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: '   ' }), 'BAD_REQUEST')
  })

  test('401 → AUTH, 429 → RATE_LIMIT, 432 → PLAN_LIMIT, 500 → SERVER', async () => {
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({ error: 'bad key' }, 401).fn }), 'AUTH', 401)
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({ error: 'slow down' }, 429).fn }), 'RATE_LIMIT', 429)
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({ error: 'plan' }, 432).fn }), 'PLAN_LIMIT', 432)
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({ error: 'boom' }, 500).fn }), 'SERVER', 500)
  })

  test('non-JSON body and wrong shape are BAD_RESPONSE', async () => {
    await expectKind(
      searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({}, 200, { jsonThrows: true }).fn }),
      'BAD_RESPONSE',
    )
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch({ query: 'x' }).fn }), 'BAD_RESPONSE')
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: fakeFetch(null).fn }), 'BAD_RESPONSE')
  })

  test('timeout and network failure are typed, not swallowed', async () => {
    const timeoutErr: any = new Error('timed out')
    timeoutErr.name = 'TimeoutError'
    const timeoutFetch = (async () => {
      throw timeoutErr
    }) as unknown as typeof fetch
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: timeoutFetch }), 'TIMEOUT')
    const networkFetch = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    await expectKind(searchTavily({ apiKey: 'tvly-k', query: 'x' }, { fetchFn: networkFetch }), 'NETWORK')
  })
})
