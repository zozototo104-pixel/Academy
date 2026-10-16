import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export type TimingMetric = { name: string; ms: number }

const timingStore = new AsyncLocalStorage<TimingMetric[]>()

function timingName(name: string) {
  return String(name || 'step').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'step'
}

export async function withTiming<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now()
  try {
    return await fn()
  } finally {
    const ms = Math.max(0, Math.round(performance.now() - start))
    console.log('[timing]', name, ms)
    timingStore.getStore()?.push({ name: timingName(name), ms })
  }
}

export async function collectTimings<T>(fn: () => Promise<T>): Promise<{ result: T; metrics: TimingMetric[] }> {
  const metrics: TimingMetric[] = []
  const result = await timingStore.run(metrics, fn)
  return { result, metrics }
}

export function serverTimingHeader(metrics: TimingMetric[]) {
  return metrics.map((metric) => `${timingName(metric.name)};dur=${Math.max(0, Math.round(metric.ms))}`).join(', ')
}

export function withServerTiming<T extends Response>(response: T, metrics: TimingMetric[]): T {
  const header = serverTimingHeader(metrics)
  if (header) response.headers.set('Server-Timing', header)
  return response
}

export type TimedJsonResult<T> = { payload: T; init?: ResponseInit }

export async function jsonWithTimings<T>(fn: () => Promise<TimedJsonResult<T>> | TimedJsonResult<T>): Promise<Response> {
  const { result, metrics } = await collectTimings(async () => {
    const result = await fn()
    const body = await withTiming('serialize', () => JSON.stringify(result.payload))
    return { ...result, body, bytes: new TextEncoder().encode(body).byteLength }
  })
  const headers = new Headers(result.init?.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('X-Response-Bytes', String(result.bytes))
  const response = new Response(result.body, { ...result.init, headers })
  return withServerTiming(response, metrics)
}

export async function withTimedResponse(fn: () => Promise<Response> | Response): Promise<Response> {
  const { result, metrics } = await collectTimings(async () => {
    const response = await fn()
    const knownBytes = response.headers.get('X-Response-Bytes') || response.headers.get('content-length')
    if (knownBytes && /^\d+$/.test(knownBytes)) {
      return { response, bytes: Number(knownBytes), body: response.body }
    }
    const body = response.body
      ? await withTiming('serialize', () => response.arrayBuffer())
      : new ArrayBuffer(0)
    return { response, bytes: body.byteLength, body }
  })

  const headers = new Headers(result.response.headers)
  headers.set('X-Response-Bytes', String(result.bytes))
  const serverTiming = serverTimingHeader(metrics)
  if (serverTiming) headers.set('Server-Timing', serverTiming)

  return new Response(result.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers,
  })
}
