import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redactDeep } from '@/lib/secret-crypto'
import { isAutoModeEnabled, parseAutoModeConfig } from '@/lib/ai-auto-mode'
import {
  AI_AUTO_LAST_REFRESH_KEY,
  ROUND_ROBIN_PROVIDERS,
  claimAiAutoRefreshRun,
  runAutoRefresh,
} from '@/lib/ai-auto-refresh'
import { CUSTOM_AI_PROVIDERS_SETTING, parseCustomTextAiProviders, textAiAutoCapabilitiesForProvider, textAiCompleteWithMetadata, textAiStaticTextModels } from '@/lib/text-ai'
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
// while auto mode is OFF. One provider per minute, including enabled
// custom providers; at most two small model probes per tick, rotating
// through the model list to eventually cover every discovered model.
const STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })
  }
  const enabledRow = await db.setting.findUnique({ where: { key: 'AI_AUTO_MODE_ENABLED' } })
  if (!isAutoModeEnabled(enabledRow?.value || '')) {
    return NextResponse.json(redactDeep({ ok: true, skipped: 'auto-mode-off' }))
  }
  const claimed = await claimAiAutoRefreshRun()
  if (!claimed) return NextResponse.json(redactDeep({ ok: true, skipped: true }))
  const store = {
    async read(keys: string[]) {
      const rows = await db.setting.findMany({ where: { key: { in: keys } } })
      return Object.fromEntries(keys.map((key) => [key, rows.find((row) => row.key === key)?.value || '']))
    },
    async write(key: string, value: string) {
      await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
    },
  }
  const customRow = await db.setting.findUnique({ where: { key: CUSTOM_AI_PROVIDERS_SETTING } })
  const customProviders = parseCustomTextAiProviders(customRow?.value || '').filter((entry) => entry.enabled).map((entry) => entry.id)
  const providers = [...ROUND_ROBIN_PROVIDERS, ...customProviders]
  const configRow = await db.setting.findUnique({ where: { key: 'AI_AUTO_MODE_CONFIG' } })
  const probeBudget = Math.min(2, parseAutoModeConfig(configRow?.value || '').probeBudgetPerRun)
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
  // The planted OCR literal exists only in the generated PNG, NEVER in
  // the prompt. This proves the model can actually read image pixels.
  // A probe bypasses automatic ranking to test exactly its assigned model.
  const callModel: ProbeCallFn = async (input) => {
    try {
      const attachments = input.kind === 'ocr' && input.planted
        ? [{ mimeType: 'image/png', base64: (await (await import('sharp')).default(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="820" height="240"><rect width="100%" height="100%" fill="white"/><text x="40" y="140" font-family="sans-serif" font-size="37" fill="black">${input.planted.replace(/[^A-Za-z0-9-]/g, '')}</text></svg>`)).png().toBuffer()).toString('base64') }]
        : undefined
      const result = await textAiCompleteWithMetadata({
        history: [{ role: 'user', text: input.prompt }],
        purpose: 'CHAT',
        system: 'Answer the user prompt exactly as instructed, with nothing else.',
        restrictToModels: [{ provider: input.provider as unknown as Exclude<TextAiProvider, 'AUTO'>, model: input.model }],
        skipAutoSelection: true,
        attachments,
        json: input.kind === 'json',
        maxOutputTokens: 256,
        timeoutMs: 8_000,
      })
      if (result.provider !== input.provider || result.model !== input.model) return { text: '', ok: false, error: 'PROBE_MODEL_MISMATCH' }
      return { text: result.text, ok: true }
    } catch (e: any) {
      return { text: '', ok: false, error: String(e?.message || 'PROBE_CALL_FAILED').slice(0, 120) }
    }
  }
  const result = await runAutoRefresh({
    store,
    providers,
    probeProviders: providers,
    probeKinds: ['json', 'ocr'],
    callModel,
    probeModelsPerRun: probeBudget,
    probeTimeoutMs: 8_000,
    capabilitiesForProvider: textAiAutoCapabilitiesForProvider,
    rankAfterRefresh: true,
    hardcodedModels: (provider) => textAiStaticTextModels(provider),
    adminChosenModel: async (provider) => {
      const row = await db.setting.findUnique({ where: { key: `${provider}_TEXT_MODEL` } })
      return row?.value || undefined
    },
    stageProfileModels,
  })
  return NextResponse.json(redactDeep({ ok: true, lastRefreshKey: AI_AUTO_LAST_REFRESH_KEY, ...result }))
}
