'use client'

import { useEffect } from 'react'

function postMetric(metric: { name: string; value: number; id?: string; rating?: string; navigationType?: string }) {
  const body = JSON.stringify({
    ...metric,
    path: `${window.location.pathname}${window.location.search}`,
    url: window.location.href,
  })

  try {
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon('/api/monitoring/web-vitals', new Blob([body], { type: 'application/json' }))
      if (ok) return
    }
  } catch {}

  fetch('/api/monitoring/web-vitals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}

function rating(name: string, value: number) {
  if (name === 'CLS') return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor'
  if (name === 'LCP') return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor'
  if (name === 'INP') return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor'
  if (name === 'FCP') return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor'
  if (name === 'TTFB') return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor'
  return 'unknown'
}

export function PerformanceMonitor() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return

    const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
    if (nav) {
      const ttfb = Math.max(0, nav.responseStart - nav.requestStart)
      postMetric({ name: 'TTFB', value: Math.round(ttfb), id: id(), rating: rating('TTFB', ttfb), navigationType: nav.type })
    }

    const observers: PerformanceObserver[] = []

    const observe = (type: string, cb: (entries: PerformanceEntry[]) => void) => {
      try {
        const po = new PerformanceObserver((list) => cb(list.getEntries()))
        po.observe({ type, buffered: true } as PerformanceObserverInit)
        observers.push(po)
      } catch {}
    }

    observe('paint', (entries) => {
      const fcp = entries.find((e) => e.name === 'first-contentful-paint')
      if (fcp) postMetric({ name: 'FCP', value: Math.round(fcp.startTime), id: id(), rating: rating('FCP', fcp.startTime) })
    })

    observe('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1]
      if (last) postMetric({ name: 'LCP', value: Math.round(last.startTime), id: id(), rating: rating('LCP', last.startTime) })
    })

    let cls = 0
    observe('layout-shift', (entries) => {
      for (const entry of entries as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
        if (!entry.hadRecentInput && typeof entry.value === 'number') cls += entry.value
      }
    })

    observe('event', (entries) => {
      const slowest = entries.reduce<number>((max, entry) => {
        const e = entry as PerformanceEntry & { interactionId?: number; duration?: number }
        return e.interactionId && typeof e.duration === 'number' ? Math.max(max, e.duration) : max
      }, 0)
      if (slowest > 0) postMetric({ name: 'INP', value: Math.round(slowest), id: id(), rating: rating('INP', slowest) })
    })

    const flushCls = () => {
      if (cls > 0) postMetric({ name: 'CLS', value: Number(cls.toFixed(4)), id: id(), rating: rating('CLS', cls) })
    }
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushCls()
    })
    window.addEventListener('pagehide', flushCls)

    return () => {
      flushCls()
      observers.forEach((po) => po.disconnect())
    }
  }, [])

  return null
}
