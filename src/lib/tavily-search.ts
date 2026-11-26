// Tavily web search client for the comprehensive-exam internet source.
// API shape verified against the official docs (docs.tavily.com,
// fetched 2026-11-25):
//   POST https://api.tavily.com/search
//   Authorization: Bearer <TAVILY_API_KEY>   (NOT api_key in the body)
//   Content-Type: application/json
//   body: { query, search_depth: 'basic', max_results, include_answer: false, include_usage: true }
//   200: { query, answer?, results: [{ title, url, content, score, raw_content?, published_date?, favicon? }],
//          response_time, usage?: { credits }, request_id }
// search_depth 'basic' costs 1 credit per search (free tier: 1,000
// credits/month, no card) — 'advanced' costs 2 and is not used here.
// No scraping, no other search provider. Failures are typed errors —
// never an empty silent result.
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
export const TAVILY_SEARCH_TIMEOUT_MS = 30_000
export const TAVILY_MAX_RESULTS = 10

export type TavilySearchResult = {
  title: string
  url: string
  content: string
  score?: number
}

export type TavilySearchOutcome = {
  query: string
  results: TavilySearchResult[]
  creditsUsed: number | null
  responseTime: number | null
}

export type TavilySearchErrorKind =
  | 'AUTH'
  | 'BAD_REQUEST'
  | 'RATE_LIMIT'
  | 'PLAN_LIMIT'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'

export class TavilySearchError extends Error {
  kind: TavilySearchErrorKind
  status?: number
  constructor(kind: TavilySearchErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'TavilySearchError'
    this.kind = kind
    this.status = status
  }
}

function errorKindForStatus(status: number): TavilySearchErrorKind {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 400) return 'BAD_REQUEST'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 432 || status === 433 || status === 434) return 'PLAN_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'SERVER'
}

export function parseTavilySearchResponse(raw: unknown): TavilySearchOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TavilySearchError('BAD_RESPONSE', 'استجابة بحث غير صالحة من Tavily')
  }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.results)) {
    throw new TavilySearchError('BAD_RESPONSE', 'استجابة بحث غير صالحة من Tavily: لا توجد نتائج')
  }
  const results: TavilySearchResult[] = []
  for (const item of body.results as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const title = String(row.title || '').trim()
    const url = String(row.url || '').trim()
    const content = String(row.content || '').trim()
    if (!url || !content) continue
    const score = typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : undefined
    results.push({ title: title || url, url, content, ...(score !== undefined ? { score } : {}) })
  }
  const credits =
    body.usage && typeof body.usage === 'object' && typeof (body.usage as Record<string, unknown>).credits === 'number'
      ? ((body.usage as Record<string, unknown>).credits as number)
      : null
  const responseTime =
    typeof body.response_time === 'number' && Number.isFinite(body.response_time)
      ? body.response_time
      : typeof body.response_time === 'string' && Number.isFinite(Number(body.response_time))
        ? Number(body.response_time)
        : null
  return {
    query: String(body.query || ''),
    results,
    creditsUsed: credits,
    responseTime,
  }
}

export async function searchTavily(
  input: { apiKey: string; query: string; maxResults?: number },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<TavilySearchOutcome> {
  const apiKey = String(input.apiKey || '').trim()
  const query = String(input.query || '').trim()
  if (!apiKey) throw new TavilySearchError('AUTH', 'مفتاح Tavily غير مضبوط')
  if (!query) throw new TavilySearchError('BAD_REQUEST', 'موضوع البحث فارغ')
  const maxResults = Math.max(1, Math.min(20, Math.floor(input.maxResults ?? TAVILY_MAX_RESULTS) || TAVILY_MAX_RESULTS))
  const fetchFn = deps.fetchFn || fetch
  let res: Response
  try {
    res = await fetchFn(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
        include_usage: true,
      }),
      signal: AbortSignal.timeout(TAVILY_SEARCH_TIMEOUT_MS),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new TavilySearchError('TIMEOUT', 'انتهت مهلة البحث عبر الإنترنت — حاول مجدداً')
    }
    throw new TavilySearchError('NETWORK', `تعذر الوصول إلى خدمة البحث: ${String(e?.message || e).slice(0, 160)}`)
  }
  if (!res.ok) {
    const kind = errorKindForStatus(res.status)
    const detail = await res.text().catch(() => '').then((t) => String(t || '').slice(0, 200))
    const messages: Record<TavilySearchErrorKind, string> = {
      AUTH: 'مفتاح Tavily غير صحيح — تحقق من المفتاح المحفوظ في إعدادات النظام',
      BAD_REQUEST: 'طلب بحث غير صالح أرسل إلى Tavily',
      RATE_LIMIT: 'تجاوزت حد طلبات Tavily المؤقت — انتظر قليلاً وحاول مجدداً',
      PLAN_LIMIT: 'انتهت حصة بحث Tavily المجانية لهذا الشهر',
      SERVER: 'خدمة بحث Tavily غير متاحة حالياً — حاول لاحقاً',
      NETWORK: 'تعذر الوصول إلى خدمة البحث',
      TIMEOUT: 'انتهت مهلة البحث عبر الإنترنت — حاول مجدداً',
      BAD_RESPONSE: 'استجابة بحث غير صالحة من Tavily',
    }
    throw new TavilySearchError(kind, detail ? `${messages[kind]} (${detail})` : messages[kind], res.status)
  }
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new TavilySearchError('BAD_RESPONSE', 'استجابة بحث غير صالحة من Tavily: ليست JSON')
  }
  return parseTavilySearchResponse(raw)
}
