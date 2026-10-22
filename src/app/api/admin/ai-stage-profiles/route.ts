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
  type StageProfileSnapshot,
} from '@/lib/ai-stage-profiles'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'

const STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

function isStage(value: unknown): value is PipelineStageName {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
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
    const stages = await Promise.all(STAGES.map(stagePayload))
    return NextResponse.json({
      stages,
      providers: KNOWN_AI_PROVIDERS,
      policies: KNOWN_ROUTER_POLICIES,
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
    if (!isStage(stage)) return NextResponse.json({ error: 'مرحلة غير صالحة' }, { status: 400 })
    const saved = await saveStageProfile(stage, snapshot as StageProfileSnapshot, actor.id)
    const payload = await stagePayload(stage)
    return NextResponse.json({ saved, stage: payload })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    if (error instanceof StageProfileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: 'تعذر حفظ بروفايل المرحلة' }, { status: 500 })
  }
}
