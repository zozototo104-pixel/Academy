import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-11-13: the student Zoom embed hangs on a white dialog — join returns
// 200 with zoomSdk, the dialog opens, but no source.zoom.us request ever
// fires and no error ever appears. Two proven defects: (1) the start effect
// returns once when the Portal hall element is not ready yet and never
// retries; (2) there is no timeout anywhere in the join path. The fix is a
// readiness-gated runner with per-stage status, a 15s timeout, in-platform
// retry and one stage-log POST. The behavioral core is the exported runner
// factory from StudentLectures.tsx; the component stays thin glue (this repo
// has no DOM test infra — component tests are source pins).

mock.module('@/lib/store', () => ({
  api: async () => ({}),
  useAppStore: () => ({ user: null }),
}))
mock.module('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: () => {} }),
}))
mock.module('@/components/aact/LecturePlayer', () => ({
  LecturePlayer: () => null,
}))

const mod: any = await import('@/components/aact/StudentLectures')
const { createZoomEmbedRunner, ZOOM_EMBED_TIMEOUT_MS } = mod

const MEETING = {
  signature: 'sig-SECRET-123',
  sdkKey: 'key-1',
  meetingNumber: '123456789',
  userName: 'طالب',
  password: 'pw-SECRET-9',
}
const MEETING_URL = 'https://zoom.us/j/123456789'
const fakeRoot = { tagName: 'DIV' }

const makeClient = (opts: { init?: (args: any) => any; join?: (args: any) => any } = {}) => {
  const calls: any = { init: [], join: [], leave: 0 }
  const client = {
    init: async (a: any) => {
      calls.init.push(a)
      return opts.init?.(a)
    },
    join: async (a: any) => {
      calls.join.push(a)
      return opts.join?.(a)
    },
    leaveMeeting: () => {
      calls.leave += 1
      return Promise.resolve()
    },
  }
  return { client, calls }
}

let loadedScripts: string[] = []
let statuses: string[] = []
let errors: { stage: string; message: string }[] = []
let reports: { stage: string; message: string }[] = []

beforeEach(() => {
  loadedScripts = []
  statuses = []
  errors = []
  reports = []
})

const baseDeps = (overrides: Record<string, any> = {}) => ({
  meeting: MEETING,
  getRoot: () => fakeRoot,
  loadScript: async (src: string) => {
    loadedScripts.push(src)
  },
  getZoomSdk: () => ({ createClient: () => { throw new Error('no client injected') } }),
  timeoutMs: 5000,
  pollIntervalMs: 5,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  onStatus: (s: string) => {
    statuses.push(s)
  },
  onError: (s: string, m: string) => {
    errors.push({ stage: s, message: m })
  },
  reportStage: (s: string, m: string) => {
    reports.push({ stage: s, message: m })
  },
  ...overrides,
})

describe('zoom embed runner — happy path and stages', () => {
  test('(a) status advances script-load → init → join → joined, and join receives the meeting credentials', async () => {
    const { client, calls } = makeClient()
    const runner = createZoomEmbedRunner(baseDeps({ getZoomSdk: () => ({ createClient: () => client }) }))
    const result = await runner.start()
    expect(result).toBe('joined')
    expect(statuses).toEqual(['script-load', 'init', 'join', 'joined'])
    expect(loadedScripts.length).toBe(7)
    expect(loadedScripts[6]).toContain('zoom-meeting-embedded-6.2.0.min.js')
    expect(calls.init.length).toBe(1)
    expect(calls.init[0].zoomAppRoot).toBe(fakeRoot)
    expect(calls.join.length).toBe(1)
    expect(calls.join[0].meetingNumber).toBe('123456789')
    expect(calls.join[0].signature).toBe('sig-SECRET-123')
    expect(calls.join[0].password).toBe('pw-SECRET-9')
    expect(errors).toEqual([])
    expect(reports).toEqual([])
  })
})

describe('zoom embed runner — the Portal race', () => {
  test('(b) when the hall element is not ready at start, no script loads until it appears — then start runs', async () => {
    let rootChecks = 0
    let firstScriptAtChecks = -1
    const getRoot = () => {
      rootChecks += 1
      return rootChecks <= 3 ? null : fakeRoot
    }
    const loadScript = async (src: string) => {
      if (firstScriptAtChecks === -1) firstScriptAtChecks = rootChecks
      loadedScripts.push(src)
    }
    const { client } = makeClient()
    const runner = createZoomEmbedRunner(
      baseDeps({ getRoot, loadScript, getZoomSdk: () => ({ createClient: () => client }), sleep: () => Promise.resolve() }),
    )
    const result = await runner.start()
    expect(result).toBe('joined')
    // The first script must load only after the element appeared (4th check).
    expect(firstScriptAtChecks).toBeGreaterThan(3)
    expect(loadedScripts.length).toBe(7)
    expect(errors).toEqual([])
  })
})

describe('zoom embed runner — timeout and retry', () => {
  test('(c) a hung script load fails with stage timeout — and the production timeout is exactly 15 seconds', async () => {
    expect(ZOOM_EMBED_TIMEOUT_MS).toBe(15_000)
    const { client } = makeClient()
    const runner = createZoomEmbedRunner(
      baseDeps({
        loadScript: () => new Promise<void>(() => {}),
        getZoomSdk: () => ({ createClient: () => client }),
        timeoutMs: 40,
      }),
    )
    const result = await runner.start()
    expect(result).toBe('timeout')
    expect(errors.length).toBe(1)
    expect(errors[0].stage).toBe('timeout')
    expect(statuses).toEqual(['script-load'])
    expect(reports.length).toBe(1)
    expect(reports[0].stage).toBe('timeout')
  })

  test('(d) retry after a timeout re-runs the whole sequence in-platform and joins', async () => {
    const hung = createZoomEmbedRunner(
      baseDeps({ loadScript: () => new Promise<void>(() => {}), timeoutMs: 40 }),
    )
    expect(await hung.start()).toBe('timeout')
    expect(errors.length).toBe(1)
    expect(reports.length).toBe(1)
    // Retry: a fresh runner, as the component retry button creates.
    const { client, calls } = makeClient()
    const retry = createZoomEmbedRunner(baseDeps({ getZoomSdk: () => ({ createClient: () => client }) }))
    expect(await retry.start()).toBe('joined')
    expect(calls.join.length).toBe(1)
    // The timed-out run reported once; the retry re-ran every stage.
    expect(statuses).toEqual(['script-load', 'script-load', 'init', 'join', 'joined'])
    expect(errors.length).toBe(1)
    expect(reports.length).toBe(1)
  })

  test('(d2) retry after a fast error also re-runs and joins', async () => {
    const failing = createZoomEmbedRunner(
      baseDeps({ getZoomSdk: () => ({ createClient: () => { throw new Error('no client') } }) }),
    )
    expect(await failing.start()).toBe('failed')
    expect(errors.length).toBe(1)
    expect(errors[0].stage).toBe('init')
    const { client, calls } = makeClient()
    const retry = createZoomEmbedRunner(baseDeps({ getZoomSdk: () => ({ createClient: () => client }) }))
    expect(await retry.start()).toBe('joined')
    expect(calls.join.length).toBe(1)
  })
})

describe('zoom embed runner — stage logging', () => {
  test('(e) on failure the stage log POSTs once to /api/client-error with the stage and no secrets', async () => {
    const fetchCalls: any[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url, init })
      return { ok: true } as any
    }) as any
    try {
      const { client } = makeClient({ init: async () => { throw new Error('init boom') } })
      // Use the DEFAULT reportStage (no override) so the real fetch path runs.
      const deps: any = baseDeps({ getZoomSdk: () => ({ createClient: () => client }) })
      delete deps.reportStage
      const runner = createZoomEmbedRunner(deps)
      const result = await runner.start()
      expect(result).toBe('failed')
      expect(errors.length).toBe(1)
      expect(errors[0].stage).toBe('init')
      expect(fetchCalls.length).toBe(1)
      expect(fetchCalls[0].url).toBe('/api/client-error')
      expect(fetchCalls[0].init.method).toBe('POST')
      const body = JSON.parse(fetchCalls[0].init.body)
      expect(body.message).toContain('stage=init')
      expect(body.message).toContain('init boom')
      expect(body.message).not.toContain('sig-SECRET-123')
      expect(body.message).not.toContain('pw-SECRET-9')
      expect(body.message).not.toContain('zoom.us')
      expect(body.message).not.toContain(MEETING_URL)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('component wiring (source pins)', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/components/aact/StudentLectures.tsx'), 'utf8')

  test('the old one-shot early return is gone; startup is gated on the runner, not the ref', () => {
    expect(src).not.toContain('if (!embeddedZoom || !zoomRootRef.current) return')
    expect(src).toContain('createZoomEmbedRunner')
    expect(src).toContain('getRoot: () => zoomRootRef.current')
  })

  test('status line renders per stage with a spinner, never a blank area while starting', () => {
    expect(src).toContain('جارٍ تحميل مكتبة Zoom')
    expect(src).toContain('جارٍ تهيئة القاعة')
    expect(src).toContain('جارٍ الانضمام إلى الاجتماع')
    expect(src).toContain('zoomStatus')
  })

  test('retry button re-runs the start in-platform', () => {
    expect(src).toContain('إعادة المحاولة داخل المنصة')
    expect(src).toContain('setZoomAttempt')
    expect(src).toContain('zoomAttempt')
  })

  test('production timeout stays exactly 15 seconds', () => {
    expect(src).toContain('ZOOM_EMBED_TIMEOUT_MS = 15_000')
    expect(ZOOM_EMBED_TIMEOUT_MS).toBe(15_000)
  })

  test('the join dialog title/description and the meetingUrl count are untouched', () => {
    expect(src).toContain('المحاضرة تعمل داخل المنصة. تأكيد الحضور الفعلي من صلاحية المشرف.')
    expect((src.match(/meetingUrl/g) ?? []).length).toBe(6)
  })
})
