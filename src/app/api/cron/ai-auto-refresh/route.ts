import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { redactDeep } from '@/lib/secret-crypto'
import { isAutoModeEnabled, parseAutoModeConfig } from '@/lib/ai-auto-mode'
import {
  AI_AUTO_LAST_REFRESH_KEY,
  ROUND_ROBIN_PROVIDERS,
  callPinnedAutoProbeModel,
  claimAiAutoRefreshRun,
  runAutoRefresh,
} from '@/lib/ai-auto-refresh'
import { CUSTOM_AI_PROVIDERS_SETTING, parseCustomTextAiProviders, textAiAutoCapabilitiesForProvider, textAiAutoConfiguredProviders, textAiStaticTextModels } from '@/lib/text-ai'
import { resolveEffectiveStageProfile } from '@/lib/ai-stage-profiles'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Cron home decision (plan step 3): a SEPARATE route, not an extension of
// ai-health. ai-health already spends a 40 s health budget inside a 60 s
// maxDuration, and it must run whether auto mode is on or off; discovery
// + probes add quota spend and time, and auto refresh must spend nothing
// while auto mode is OFF. One provider per hour, including enabled
// custom providers; at most one model (two tiny probe calls) per tick, rotating
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
    async delete(key: string) {
      await db.setting.delete({ where: { key } }).catch(() => {})
    },
  }
  const customRow = await db.setting.findUnique({ where: { key: CUSTOM_AI_PROVIDERS_SETTING } })
  const customProviders = parseCustomTextAiProviders(customRow?.value || '').filter((entry) => entry.enabled).map((entry) => entry.id)
  const configured = new Set(await textAiAutoConfiguredProviders())
  const providers = [...ROUND_ROBIN_PROVIDERS, ...customProviders].filter((provider) => configured.has(provider))
  if (!providers.length) return NextResponse.json(redactDeep({ ok: true, skipped: 'no-configured-providers' }))
  const configRow = await db.setting.findUnique({ where: { key: 'AI_AUTO_MODE_CONFIG' } })
  const probeBudget = Math.min(1, parseAutoModeConfig(configRow?.value || '').probeBudgetPerRun)
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
  const result = await runAutoRefresh({
    store,
    providers,
    probeProviders: providers,
    probeKinds: ['json', 'ocr'],
    callModel: callPinnedAutoProbeModel,
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
