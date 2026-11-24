import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  AI_AUTO_NO_MODEL_PENDING_KEY_PREFIX,
  AUTO_PURPOSES,
  AUTO_VOICE_EXCLUSION_NOTE,
  AI_AUTO_MODE_TRANSITIONS_KEY,
  autoRankingKey,
  isAutoModeEnabled,
  noModelPendingKey,
  parseAutoModeTransitions,
  parseAutoRankingPayload,
  parseNoModelPendingEvent,
  type NoModelPendingEvent,
  type ScoreComponents,
} from '@/lib/ai-auto-mode'
import {
  AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX,
  AI_AUTO_LAST_REFRESH_KEY,
  parseLastRefreshState,
} from '@/lib/ai-auto-refresh'
import {
  parseProviderTiers,
  textAiDiagnostics,
  textAiModelHealthSnapshot,
  textAiRouterStateSnapshot,
} from '@/lib/text-ai'

// Step 8 — monitoring dashboard API (admin-only GET).
//
// Composes EXISTING readers only and makes NO live provider calls on
// GET: rankings come from the stored AI_AUTO_RANKING:<purpose> rows,
// health/quota/cooldown from textAiModelHealthSnapshot() +
// textAiRouterStateSnapshot() + textAiDiagnostics(), the last refresh
// from AI_AUTO_LAST_REFRESH, the last capability check from the stored
// AI_AUTO_CAPABILITY_PROBES:<provider> rows (probedAt), transitions
// from AI_AUTO_MODE_TRANSITIONS, and failover history from
// AiPipelineOperationLog rows with fallbackUsed=true.
//
// Cost honesty: there is NO balance API anywhere, so every candidate
// reports balance:'unknown'. costTier comes ONLY from the admin's own
// AI_PROVIDER_TIERS list (FREE/PAID); an undocumented provider is
// 'unknown' — NEVER labelled free. The UI renders unknown-cost models
// visually distinct from FREE ones.
//
// There is NO dedicated AI_AUTO_LAST_CAPABILITY_CHECK timestamp key
// anywhere in the codebase (checked 2026-11-24): when no probe row
// carries a probedAt, lastCapabilityCheck is null and the dashboard
// shows an honest "not recorded yet" state instead of inventing one.
//
// The AiAutoFailoverEvent Prisma model exists only as a migration file;
// its table does not exist in production, so it is NEVER queried here.
// Failover history reads AiPipelineOperationLog (fallbackUsed is a real
// Boolean column, schema.prisma:224).

export type MonitoringCostTier = 'free' | 'paid' | 'unknown'

export interface MonitoringNoModelEvent {
  purpose: string
  at: string
  updatedAt: string
  cause: 'PROVEN_EMPTY' | 'NEVER_COMPUTED'
  excludedReasons: string[]
  choice: 'STAY_AUTO' | null
  choiceAt: string | null
}

export interface MonitoringNoQualifiedModel {
  pending: true
  purposes: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  lastPurpose: string
  events: MonitoringNoModelEvent[]
}

// Decision 3 (Haris 2026-11-24): the pending "no qualified model"
// events, newest first. A malformed row is dropped, never invented.
// The per-event `choice`/`choiceAt` extend the specified shape so the
// dashboard can show that Haris already chose to stay on auto.
function noQualifiedModelFromPendingRows(
  rows: Array<{ key: string; value: string }>,
): MonitoringNoQualifiedModel | null {
  const events = rows
    .map((row) => parseNoModelPendingEvent(row.value))
    .filter((event): event is NoModelPendingEvent => !!event)
  if (!events.length) return null
  events.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const firstSeen = events.map((event) => Date.parse(event.at)).filter(Number.isFinite)
  const lastSeen = events.map((event) => Date.parse(event.updatedAt)).filter(Number.isFinite)
  return {
    pending: true,
    purposes: [...new Set(events.map((event) => event.purpose))],
    firstSeenAt: firstSeen.length ? new Date(Math.min(...firstSeen)).toISOString() : null,
    lastSeenAt: lastSeen.length ? new Date(Math.max(...lastSeen)).toISOString() : null,
    lastPurpose: events[0].purpose,
    events: events.map((event) => ({
      purpose: event.purpose,
      at: event.at,
      updatedAt: event.updatedAt,
      cause: event.cause,
      excludedReasons: event.excludedReasons,
      choice: event.choice,
      choiceAt: event.choiceAt,
    })),
  }
}

export interface MonitoringCandidate {
  provider: string
  model: string
  score: number | null
  components: ScoreComponents | null
  excludedReason: string | null
  costTier: MonitoringCostTier
  balance: 'unknown'
}

export interface MonitoringRanking {
  purpose: string
  computedAt: string | null
  top: MonitoringCandidate | null
  candidates: MonitoringCandidate[]
}

function costTierForProvider(
  provider: string,
  tiers: Partial<Record<string, string>>,
): MonitoringCostTier {
  const tier = String(tiers[provider.toUpperCase()] || '').toUpperCase()
  if (tier === 'FREE') return 'free'
  if (tier === 'PAID') return 'paid'
  return 'unknown'
}

// Last capability check, derived ONLY from stored probe rows. Each
// AI_AUTO_CAPABILITY_PROBES:<provider> row written by the refresh job
// carries a probedAt ISO timestamp; the newest one across providers is
// the last check. No probe row with a valid timestamp => null (the
// dashboard must say "not recorded yet", never a guessed time).
function lastCapabilityCheckFromProbeRows(
  rows: Array<{ key: string; value: string }>,
): { at: string; providers: Array<{ provider: string; probedAt: string }> } | null {
  const perProvider: Array<{ provider: string; probedAt: string }> = []
  for (const row of rows) {
    const provider = String(row.key || '').slice(AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX.length).toUpperCase()
    if (!provider) continue
    try {
      const parsed = JSON.parse(row.value || '{}') as Record<string, unknown>
      const probedAt = parsed.probedAt
      if (typeof probedAt !== 'string' || !Number.isFinite(Date.parse(probedAt))) continue
      perProvider.push({ provider, probedAt })
    } catch {
      continue
    }
  }
  if (!perProvider.length) return null
  perProvider.sort((a, b) => Date.parse(b.probedAt) - Date.parse(a.probedAt))
  return { at: perProvider[0].probedAt, providers: perProvider }
}

export async function GET() {
  try {
    await requireAdmin()
    const [
      modeRow,
      lastRefreshRow,
      transitionsRow,
      tiersRow,
      rankingRows,
      probeRows,
      pendingRows,
      failovers,
      autoFailovers,
      health,
      routerState,
      diagnostics,
    ] = await Promise.all([
      db.setting.findUnique({ where: { key: 'AI_AUTO_MODE_ENABLED' } }),
      db.setting.findUnique({ where: { key: AI_AUTO_LAST_REFRESH_KEY } }),
      db.setting.findUnique({ where: { key: AI_AUTO_MODE_TRANSITIONS_KEY } }),
      db.setting.findUnique({ where: { key: 'AI_PROVIDER_TIERS' } }),
      db.setting.findMany({ where: { key: { startsWith: 'AI_AUTO_RANKING:' } } }),
      db.setting.findMany({ where: { key: { startsWith: AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX } } }),
      db.setting.findMany({ where: { key: { startsWith: AI_AUTO_NO_MODEL_PENDING_KEY_PREFIX } } }),
      db.aiPipelineOperationLog.findMany({
        where: { fallbackUsed: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          createdAt: true,
          stage: true,
          provider: true,
          model: true,
          success: true,
          failureCategory: true,
          fallbackUsed: true,
          latencyMs: true,
          bookId: true,
          unitId: true,
        },
      }),
      db.aiAutoFailoverEvent?.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, createdAt: true, provider: true, model: true, purpose: true, failureKind: true },
      }).catch(() => []) ?? Promise.resolve([]),
      textAiModelHealthSnapshot(),
      textAiRouterStateSnapshot(),
      textAiDiagnostics(),
    ])
    const auto = isAutoModeEnabled(modeRow?.value || '')
    const tiers = parseProviderTiers(tiersRow?.value || '') as Partial<Record<string, string>>
    const rankingByKey = new Map<string, string>(rankingRows.map((row) => [row.key, String(row.value || '')]))
    const rankings: MonitoringRanking[] = AUTO_PURPOSES.map((purpose) => {
      const payload = parseAutoRankingPayload(rankingByKey.get(autoRankingKey(purpose)) || '')
      const candidates: MonitoringCandidate[] = payload.candidates.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        score: typeof candidate.score === 'number' ? candidate.score : null,
        components: candidate.components || null,
        excludedReason: candidate.excludedReason || null,
        costTier: costTierForProvider(candidate.provider, tiers),
        // No balance API exists: the scorer records balance 'unknown'
        // and so does this payload. Never a remaining-balance figure.
        balance: 'unknown' as const,
      }))
      return {
        purpose,
        computedAt: payload.computedAt,
        top: candidates.find((candidate) => !candidate.excludedReason) || null,
        candidates,
      }
    })
    return NextResponse.json({
      mode: { auto, value: auto ? '1' : '0' },
      rankings,
      noQualifiedModel: noQualifiedModelFromPendingRows(pendingRows),
      health,
      routerState,
      diagnostics,
      lastRefresh: parseLastRefreshState(lastRefreshRow?.value || ''),
      lastCapabilityCheck: lastCapabilityCheckFromProbeRows(probeRows),
      transitions: parseAutoModeTransitions(transitionsRow?.value || ''),
      failovers: failovers.map((row) => ({
        id: row.id,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt || ''),
        stage: row.stage,
        provider: row.provider,
        model: row.model,
        success: row.success,
        failureCategory: row.failureCategory,
        fallbackUsed: row.fallbackUsed,
        latencyMs: row.latencyMs,
        bookId: row.bookId,
        unitId: row.unitId,
      })),
      autoFailovers: autoFailovers.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      voiceNote: AUTO_VOICE_EXCLUSION_NOTE,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تحميل لوحة مراقبة الذكاء' }, { status: 500 })
  }
}

// Decision 3 (Haris 2026-11-24) — the admin's answer to a pending
// "no qualified model" event. Admin-only, like GET.
// - 'stay-auto' (purpose required, must be a known purpose): records
//   choice 'STAY_AUTO' + choiceAt on that purpose's event WITHOUT
//   clearing pending — the banner stays until a model qualifies.
// - 'resolve' (purpose optional): deletes the purpose's pending key,
//   or all pending keys when no purpose is given — used after the
//   switch to manual. Deleting a missing key is a no-op success.
export async function POST(request: NextRequest) {
  try {
    await requireAdmin()
    const body = (await request.json().catch(() => null)) as { action?: unknown; purpose?: unknown } | null
    const action = body?.action
    if (action !== 'stay-auto' && action !== 'resolve') {
      return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
    }
    const purposeRaw = typeof body?.purpose === 'string' ? body.purpose.trim().toUpperCase() : ''
    const isKnownPurpose = (AUTO_PURPOSES as readonly string[]).includes(purposeRaw)
    if (action === 'stay-auto') {
      if (!purposeRaw || !isKnownPurpose) {
        return NextResponse.json({ error: 'مهمة غير معروفة' }, { status: 400 })
      }
      const key = noModelPendingKey(purposeRaw)
      const row = await db.setting.findUnique({ where: { key } })
      const event = parseNoModelPendingEvent(row?.value || '')
      if (!event) return NextResponse.json({ error: 'لا يوجد تنبيه معلّق لهذه المهمة' }, { status: 404 })
      const now = new Date().toISOString()
      const value = JSON.stringify({ ...event, choice: 'STAY_AUTO', choiceAt: now, updatedAt: now })
      await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
      return NextResponse.json({ ok: true })
    }
    if (purposeRaw && !isKnownPurpose) {
      return NextResponse.json({ error: 'مهمة غير معروفة' }, { status: 400 })
    }
    if (purposeRaw) {
      await db.setting.deleteMany({ where: { key: noModelPendingKey(purposeRaw) } }).catch(() => {})
    } else {
      await db.setting.deleteMany({ where: { key: { startsWith: AI_AUTO_NO_MODEL_PENDING_KEY_PREFIX } } }).catch(() => {})
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}
