import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  findActiveUnitGenerationJob,
  loadUnitRegenerationSources,
  markUnitRegenerationJobFailed,
  runUnitRegeneration,
} from '@/lib/unit-regeneration'
import {
  findPendingRegenerationIntent,
  maybeDeferUnitRegenerationForRepair,
  resolvePendingRegenerationIntent,
} from '@/lib/unit-regeneration-link'

export const runtime = 'nodejs'
export const maxDuration = 240
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ unitId: string }> }

// POST /api/admin/program-units/[unitId]/regenerate — regenerate ONE damaged
// unit's content into a PENDING UnitRegenerationDraft preview. The published
// Unit row is NEVER written here (not even for APPROVED units — that is the
// point: a published wrong unit gets a preview first, and only an explicit
// approve applies it). Generation reuses generateUnitContentWithAi, which
// already excludes garbled chunks / pending-review items and refuses with
// UNIT_SOURCE_REQUIRES_REPAIR when nothing healthy remains; the assessment
// reports the same gaps to the admin before the AI call.
//
// Repair-first (PR #212): when the unit's sources are garbled and the book
// repair has NOT been exhausted, this does NOT generate and does NOT
// refuse — it defers with HTTP 202 (REPAIR_RUNNING), enqueues a repair
// job when none exists, records a UnitRegenerationIntent, and the repair
// driver / cron resumes generation automatically when the repair
// finishes. Exclusion applies ONLY after the repair COMPLETED with garbled
// sources remaining. The generation core lives in
// src/lib/unit-regeneration.ts; this route is auth + deferral + response
// mapping. Cancel a pending auto-resume with { action: 'CANCEL' }; retry
// is just POST regenerate again.
export async function POST(req: NextRequest, context: Context) {
  let unitIdForIntent = ''
  try {
    const admin = await requireAdmin()
    const { unitId } = await context.params
    unitIdForIntent = unitId
    const body = await req.json().catch(() => ({}))

    // Cancel a pending auto-resume intent (admin-only, audit-logged).
    // Cancelling never touches the repair job or any draft.
    if (body?.action === 'CANCEL') {
      const intent = await findPendingRegenerationIntent(unitId)
      if (!intent) return NextResponse.json({ error: 'REGENERATION_INTENT_NOT_FOUND' }, { status: 404 })
      await db.unitRegenerationIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'CANCELLED', resolution: 'CANCELLED_BY_ADMIN', resolvedAt: new Date() },
      })
      await audit(admin, 'CANCEL_UNIT_REGENERATION_INTENT', 'Unit', unitId,
        `ألغى المسؤول الاستكمال التلقائي لإعادة توليد الوحدة المتضررة (النية ${intent.id}) — لن تُستكمل تلقائياً بعد إصلاح الكتاب.`
      ).catch((auditError) => console.error('Unit regeneration intent cancel audit failed:', auditError))
      return NextResponse.json({ ok: true, cancelled: true, intentId: intent.id })
    }

    const active = await findActiveUnitGenerationJob(unitId)
    if (active.state === 'ACTIVE') return NextResponse.json({ ok: true, job: active.job, resumed: true })
    if (active.state === 'STALE_FAILED') {
      return NextResponse.json({ ok: false, error: 'توقفت، أعد المحاولة' }, { status: 409 })
    }
    const unit = await db.unit.findUnique({
      where: { id: unitId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true } } },
    })
    if (!unit) return NextResponse.json({ error: 'UNIT_NOT_FOUND' }, { status: 404 })
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) {
      return NextResponse.json({ error: 'UNIT_OUTLINE_SOURCE_REQUIRED' }, { status: 400 })
    }

    // Repair-first deferral: AFTER loading sources and assessing, BEFORE
    // creating the generation job and BEFORE the healthy-sources
    // assertion. A source-loading failure here is NOT a deferral
    // decision — fall through so the core reproduces the original
    // failure path (job created, then the same error, job marked FAILED).
    try {
      const sources = await loadUnitRegenerationSources(unitId)
      const deferral = await maybeDeferUnitRegenerationForRepair(sources)
      if (deferral.deferred) {
        return NextResponse.json({
          ok: true,
          deferred: true,
          error: 'REPAIR_RUNNING',
          repairJobId: deferral.repairJobId,
          repairStatus: deferral.repairStatus,
          intentId: deferral.intentId,
          message: deferral.message,
        }, { status: 202 })
      }
    } catch (error: any) {
      const message = String(error?.message || error)
      if (message === 'UNIT_SOURCE_CHUNKS_REQUIRED' || message === 'UNIT_V2_KNOWLEDGE_REQUIRED') {
        // Fall through to the core: same error, same FAILED-job path.
      } else {
        throw error
      }
    }

    const result = await runUnitRegeneration(unitId, { deadlineMs: Date.now() + 210_000 })
    if (result.outcome === 'ALREADY_RUNNING') {
      return NextResponse.json({ ok: true, job: result.job, resumed: true })
    }
    if (result.outcome === 'STALE_JOB_FAILED') {
      return NextResponse.json({ ok: false, error: 'توقفت، أعد المحاولة' }, { status: 409 })
    }
    if (result.outcome === 'LEASE_LOST') {
      return NextResponse.json({ error: 'UNIT_REGENERATION_LEASE_LOST' }, { status: 409 })
    }
    // A manual regenerate that succeeds also fulfils any pending
    // auto-resume intent for the unit (the draft it was waiting for now
    // exists); a refusal after repair exhaustion resolves it the same
    // way in the catch below.
    await resolvePendingRegenerationIntent(unitId, 'DRAFT_CREATED')
    await audit(admin, 'REGENERATE_DAMAGED_UNIT_PREVIEW', 'Unit', unit.id,
      `إعادة توليد محتوى الوحدة المتضررة كمسودة معاينة (لم يُمس المحتوى المنشور): ${unit.title}`
    ).catch((auditError) => console.error('Unit regeneration audit failed after commit:', auditError))
    return NextResponse.json({
      ok: true,
      draft: { id: result.draft.id, status: result.draft.status, createdAt: result.draft.createdAt, summary: result.generated.summary, objectives: result.generated.objectives, content: result.generated.content, gaps: result.gaps, sourceKnowledgeIds: [...new Set(result.generated.content.flatMap((section) => section.sourceKnowledgeIds || []))] },
      gaps: result.gaps,
      job: { id: result.job.id, status: 'COMPLETED' },
    })
  } catch (error: any) {
    const message = String(error?.message || error)
    const failedJobId = error?.regenerationJobId as string | undefined
    if (failedJobId) {
      const paused = await markUnitRegenerationJobFailed(failedJobId, error)
      if (paused) return NextResponse.json({ ok: false, status: 'PAUSED', retryAt: new Date(Date.now() + 5 * 60_000).toISOString(), error: message }, { status: 503 })
      if (message === 'UNIT_SOURCE_REQUIRES_REPAIR') {
        // Final refusal after repair exhaustion (or with no repair path):
        // the waiting intent, if any, is resolved — not left pending.
        if (unitIdForIntent) await resolvePendingRegenerationIntent(unitIdForIntent, 'REFUSED_NO_HEALTHY_SOURCES')
        return NextResponse.json({ ok: false, error: 'UNIT_SOURCE_REQUIRES_REPAIR', reason: 'لا توجد مصادر سليمة كافية لإعادة توليد هذه الوحدة — أصلح مصادر الكتاب أولاً' }, { status: 400 })
      }
    }
    if (message === 'UNIT_SOURCE_REQUIRES_REPAIR') {
      return NextResponse.json({ ok: false, error: 'UNIT_SOURCE_REQUIRES_REPAIR', reason: 'لا توجد مصادر سليمة كافية لإعادة توليد هذه الوحدة — أصلح مصادر الكتاب أولاً' }, { status: 400 })
    }
    if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('damaged unit regeneration error:', error)
    return NextResponse.json({ error: message || 'تعذر إعادة توليد محتوى الوحدة' }, { status: 500 })
  }
}
