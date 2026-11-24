import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redactDeep } from '@/lib/secret-crypto'
import { isAutoModeEnabled } from '@/lib/ai-auto-mode'
import {
  AI_AUTO_LAST_REFRESH_KEY,
  AI_AUTO_PROBE_PROVIDERS_KEY,
  claimAiAutoRefreshRun,
  runAutoRefresh,
} from '@/lib/ai-auto-refresh'
import { textAiCompleteJsonWithMetadata, textAiStaticTextModels } from '@/lib/text-ai'
import { resolveEffectiveStageProfile } from '@/lib/ai-stage-profiles'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'
import type { ProbeCallFn } from '@/lib/ai-capability-probes'
import type { TextAiProvider } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Cron home decision (plan step 3): a SEPARATE route, not an extension of
// ai-health. ai-health already spends a 40 s health budget inside a 60 s
// maxDuration, and it must run whether auto mode is on or off; discovery
// + probes add quota spend and time, and auto refresh must spend nothing
// while auto mode is OFF. This route is independently claimable (one
// winner/hour) and refreshes exactly ONE provider per run (round-robin).
//
// Probes in this route are JSON-shape only: the OCR probe needs the
// planted literal rendered as a 1-page image, and this route has no image
// renderer — the OCR evaluator + runner exist (ai-capability-probes.ts)
// and accept an injected callModel, so the image-backed probe plugs in
// from the book pipeline (step 6) without a code change here. The
// long-context probe is not run by default either: a 100k-char input
// costs real tokens on every run.
const STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const claimed = await claimAiAutoRefreshRun()
  if (!claimed) return NextResponse.json(redactDeep({ ok: true, skipped: true }))
  const enabledRow = await db.setting.findUnique({ where: { key: 'AI_AUTO_MODE_ENABLED' } })
  if (!isAutoModeEnabled(enabledRow?.value || '')) {
    return NextResponse.json(redactDeep({ ok: true, skipped: 'auto-mode-off' }))
  }
  const store = {
    async read(keys: string[]) {
      const rows = await db.setting.findMany({ where: { key: { in: keys } } })
      return Object.fromEntries(keys.map((key) => [key, rows.find((row) => row.key === key)?.value || '']))
    },
    async write(key: string, value: string) {
      await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
    },
  }
  const probeProvidersRaw = (await store.read([AI_AUTO_PROBE_PROVIDERS_KEY]))[AI_AUTO_PROBE_PROVIDERS_KEY] || ''
  let probeProviders: string[] = []
  try {
    const parsed = JSON.parse(probeProvidersRaw || '[]')
    if (Array.isArray(parsed)) probeProviders = parsed.map(String)
  } catch {
    probeProviders = []
  }
  // Stage-profile model refs for reconciliation warnings (read-only).
  let stageProfileModels: Array<{ provider: string; model: string }> = []
  try {
    for (const stage of STAGES) {
      const resolution = await resolveEffectiveStageProfile(stage)
      if (resolution.kind !== 'stage') continue
      stageProfileModels.push(...resolution.snapshot.models)
      stageProfileModels.push(...(resolution.snapshot.verifier?.preferred || []))
    }
  } catch {
    stageProfileModels = []
  }
  // Probe call pinned to exactly one model via restrictToModels, with a
  // hard 15 s timeout. Never runs on the live request path.
  const callModel: ProbeCallFn = async (input) => {
    try {
      const { text } = await textAiCompleteJsonWithMetadata({
        history: [{ role: 'user', text: input.prompt }],
        purpose: 'CHAT',
        restrictToModels: [{ provider: input.provider as unknown as Exclude<TextAiProvider, 'AUTO'>, model: input.model }],
        timeoutMs: 15_000,
        json: input.kind === 'json',
      })
      return { text, ok: true }
    } catch (e: any) {
      return { text: '', ok: false, error: String(e?.message || 'PROBE_CALL_FAILED').slice(0, 120) }
    }
  }
  const result = await runAutoRefresh({
    store,
    probeProviders,
    probeKinds: ['json'],
    callModel,
    hardcodedModels: (provider) => textAiStaticTextModels(provider),
    adminChosenModel: async (provider) => {
      const row = await db.setting.findUnique({ where: { key: `${provider}_TEXT_MODEL` } })
      return row?.value || undefined
    },
    stageProfileModels,
  })
  return NextResponse.json(redactDeep({ ok: true, lastRefreshKey: AI_AUTO_LAST_REFRESH_KEY, ...result }))
}
