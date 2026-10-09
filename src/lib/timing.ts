import { AsyncLocalStorage } from 'node:async_hooks'

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
