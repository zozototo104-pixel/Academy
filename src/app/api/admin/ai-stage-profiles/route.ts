import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  KNOWN_AI_PROVIDERS,
  KNOWN_ROUTER_POLICIES,
  getCurrentStageProfile,
  listStageProfileVersions,
  saveStageProfile,
  StageProfileValidationError,
  validateStageProfileSnapshot,
} from '@/lib/ai-stage-profiles'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'
import { getAiAdvisorReadiness } from '@/lib/ai-advisor-readiness'
import {
  AdvisorAdviceApplicationError,
  listAdvisorAdvice,
  markAdvisorAdviceApplied,
  validateAdvisorAdviceApplication,
} from '@/lib/ai-advisor-advice'
import {
  enqueuePendingReviewQuestionsForProfileChange,
  failedReviewRecheckEnqueueReport,
  parseReviewRecheckEnqueueRequest,
  type ReviewRecheckEnqueueReport,
} from '@/lib/question-recheck-admin'

const STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

function isStage(value: unknown): value is PipelineStageName {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

function modelRefsKey(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is { provider: unknown; model: unknown } => !!item && typeof item === 'object')
    .map((item) => `${String(item.provider || '')}:${String(item.model || '')}`)
}

function snapshotKey(snapshot: unknown): string {
  const value = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, any>
  const verifier = value.verifier && typeof value.verifier === 'object' ? value.verifier as Record<string, any> : null
  return JSON.stringify({
    enabled: !!value.enabled,
    provider: value.provider ?? null,
    policy: value.policy ?? null,
    models: modelRefsKey(value.models),
    allowGlobalFallback: value.allowGlobalFallback !== false,
    verifier: verifier
      ? {
          preferred: modelRefsKey(verifier.preferred),
          strict: !!verifier.strict,
        }
      : null,
  })
}

async function stageStats(stage: PipelineStageName) {
  const [runs, successes, failures, fallbacks] = await Promise.all([
    db.aiPipelineOperationLog.count({ where: { stage } }),
    db.aiPipelineOperationLog.count({ where: { stage, success: true } }),
    db.aiPipelineOperationLog.count({ where: { stage, success: false } }),
    db.aiPipelineOperationLog.count({ where: { stage, fallbackUsed: true } }),
  ])
  return { runs, successes, failures, fallbacks }
}

async function stagePayload(stage: PipelineStageName) {
  const [current, versions, stats, recentLogs] = await Promise.all([
    getCurrentStageProfile(stage),
    listStageProfileVersions(stage),
    stageStats(stage),
    db.aiPipelineOperationLog.findMany({
      where: { stage },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        profileId: true,
        profileVersion: true,
        provider: true,
        model: true,
        policy: true,
        success: true,
        failureCategory: true,
        fallbackUsed: true,
        latencyMs: true,
        outputCount: true,
        bookId: true,
        unitId: true,
      },
    }),
  ])
  return {
    stage,
    current,
    versions: versions.slice(0, 8),
    stats,
    recentLogs,
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const [stages, advisorReadiness, advisorAdvice] = await Promise.all([
      Promise.all(STAGES.map(stagePayload)),
      getAiAdvisorReadiness(),
      listAdvisorAdvice('OPEN'),
    ])
    return NextResponse.json({
      stages,
      providers: KNOWN_AI_PROVIDERS,
      policies: KNOWN_ROUTER_POLICIES,
      advisorReadiness,
      advisorAdvice,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل بروفايلات المراحل' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireAdmin()
    const body = await req.json().catch(() => null)
    const stage = (body as { stage?: unknown } | null)?.stage
    const snapshot = (body as { snapshot?: unknown } | null)?.snapshot
    const advisorAdviceId = (body as { advisorAdviceId?: unknown } | null)?.advisorAdviceId
    if (!isStage(stage)) return NextResponse.json({ error: 'مرحلة غير صالحة' }, { status: 400 })
    const validatedSnapshot = validateStageProfileSnapshot(stage, snapshot)
    const current = await getCurrentStageProfile(stage)
    const currentProfileVersion = current?.version ?? 0
    if (current && snapshotKey(current.snapshot) === snapshotKey(validatedSnapshot)) {
      return NextResponse.json({ error: 'لا يوجد تغيير للحفظ' }, { status: 409 })
    }
    if (advisorAdviceId != null) {
      if (typeof advisorAdviceId !== 'string' || !advisorAdviceId.trim()) {
        return NextResponse.json({ error: 'معرّف توصية المستشار غير صالح' }, { status: 400 })
      }
      await validateAdvisorAdviceApplication(advisorAdviceId.trim(), stage, validatedSnapshot, currentProfileVersion)
    }
    const saved = await saveStageProfile(stage, validatedSnapshot, actor.id)
    if (typeof advisorAdviceId === 'string' && advisorAdviceId.trim()) {
      await markAdvisorAdviceApplied(advisorAdviceId.trim(), actor.id, saved.version)
    }
    const payload = await stagePayload(stage)
    return NextResponse.json({ saved, stage: payload, advisorAdviceId: typeof advisorAdviceId === 'string' ? advisorAdviceId.trim() : null })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    if (error instanceof StageProfileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof AdvisorAdviceApplicationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: 'تعذر حفظ بروفايل المرحلة' }, { status: 500 })
  }
}
