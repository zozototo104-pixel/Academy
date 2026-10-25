import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { unitExamQualityFlags } from '@/lib/unit-exam-policy'
import { verifyQuestionsWithCrossProvider, type VerifiableQuestion } from '@/lib/question-verifier'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Re-verify grounding for APPROVED unit questions that never received the
// SOURCE_GROUNDED stamp (typically generated before the grounding gate
// existed).
//
// HARD RULE (owner-confirmed 2026-10-25): the AI verifier is the SOLE
// stamping authority. Nothing here stamps, un-stamps, or invents a verdict:
// classification below only decides which items may even be SENT to the
// existing second-provider verifier (verifyQuestionsWithCrossProvider, the
// same mechanism the generation job uses, verifier != generator enforced
// inside it). An item gets SOURCE_GROUNDED only when that verifier confirms
// it against original book text.
//
// OCR EXCEPTION (owner-approved 2026-10-25, reverify-only): this endpoint
// passes allowOcrGrounding, so VISION_OCR items it sends are stamped when
// the verifier confirms them — because reverify touches APPROVED items
// only and is admin-activated after human review. Generation keeps the
// default (OCR stripped). OCR_DERIVED_SOURCE is always kept next to the
// stamp, so OCR provenance stays visible.
//
// Progress fix (2026-10-25-g): the previous version took the FIRST 10
// ungrounded items per press, so a batch of only-skipped items never
// changed anything and every press repeated the same 10 forever. This
// version classifies ALL ungrounded items first (cheap, no AI calls), then
// sends up to 10 VERIFIABLE items per press — skipped items never consume
// a batch slot. Items the verifier already rejected in an earlier reverify
// press are terminal (marked in reviewNotes) and are not re-sent.
const BATCH_CAP = 10

function clean(value: unknown, max = 12000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function parseOptions(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function parseNotes(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function provenanceOf(notes: Record<string, unknown>): { provider: string; model: string } | null {
  const prov = notes.aiProvenance
  if (!prov || typeof prov !== 'object' || Array.isArray(prov)) return null
  const provider = typeof (prov as Record<string, unknown>).provider === 'string' ? String((prov as Record<string, unknown>).provider).trim() : ''
  const model = typeof (prov as Record<string, unknown>).model === 'string' ? String((prov as Record<string, unknown>).model).trim() : ''
  return provider && model ? { provider, model } : null
}

function hasGroundedFlag(flags: string | null | undefined) {
  return unitExamQualityFlags(flags).includes('SOURCE_GROUNDED')
}

// POST /api/admin/units/[id]/questions/reverify-grounding — admin only.
// Body: {} — the unit id comes from the path. Classifies every APPROVED
// question lacking SOURCE_GROUNDED, sends up to 10 verifiable ones to the
// existing AI verifier, and stamps only the ones it confirms.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const unitId = clean(id, 100)
    if (!unitId) return NextResponse.json({ error: 'معرف الوحدة مطلوب' }, { status: 400 })
    const unit = await db.unit.findUnique({ where: { id: unitId }, select: { id: true, title: true, programId: true } })
    if (!unit) return NextResponse.json({ error: 'الوحدة غير موجودة' }, { status: 404 })

    const items = await db.questionBankItem.findMany({
      where: { unitId: unit.id, status: 'APPROVED' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        knowledgeItemId: true,
        text: true,
        type: true,
        options: true,
        correctAnswer: true,
        modelAnswer: true,
        sourceEvidence: true,
        qualityFlags: true,
        reviewNotes: true,
      },
    })
    const candidates = items.filter((item) => !hasGroundedFlag(item.qualityFlags))

    // Classify ALL candidates first (no AI calls here): skipped items must
    // never consume a batch slot, or the button loops on them forever.
    const knowledgeIds = [...new Set(candidates.map((item) => item.knowledgeItemId).filter((v): v is string => Boolean(v)))]
    const knowledgeRows = knowledgeIds.length
      ? await db.bookKnowledgeItem.findMany({
          where: { id: { in: knowledgeIds } },
          select: { id: true, chunkId: true, summary: true, excerpt: true, textProvenance: true },
        })
      : []
    const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row] as const))
    const chunkIds = [...new Set(knowledgeRows.map((row) => row.chunkId).filter((v): v is string => Boolean(v)))]
    const chunkRows = chunkIds.length
      ? await db.bookChunk.findMany({ where: { id: { in: chunkIds } }, select: { id: true, index: true, pageStart: true, pageEnd: true, text: true } })
      : []
    const chunkById = new Map(chunkRows.map((row) => [row.id, row] as const))

    type Prepared = { item: (typeof candidates)[number]; question: VerifiableQuestion; sourceText: string; provenance: { provider: string; model: string }; textProvenance: VerifiableQuestion['textProvenance'] }
    const verifiable: Prepared[] = []
    let skippedNoSource = 0
    let skippedNoProvenance = 0
    // OCR items are NO LONGER skipped here: owner-approved 2026-10-25,
    // reverify (APPROVED items only, admin-activated) may stamp them when
    // the verifier confirms them (allowOcrGrounding below). Kept at 0 for
    // response compatibility; the OCR marker is preserved on stamping.
    const skippedOcr = 0
    let alreadyRechecked = 0

    for (const item of candidates) {
      const notes = parseNotes(item.reviewNotes)
      // Terminal: the AI verifier already rejected this item in an earlier
      // reverify press (marker written below on rejection). Do not re-send.
      const verifierNote = notes.verifier
      if (verifierNote && typeof verifierNote === 'object' && !Array.isArray(verifierNote) && (verifierNote as Record<string, unknown>).source === 'reverify') {
        alreadyRechecked += 1
        continue
      }
      const knowledge = item.knowledgeItemId ? knowledgeById.get(item.knowledgeItemId) : null
      const rawProvenance = knowledge?.textProvenance
      const textProvenance = rawProvenance === 'VISION_OCR' || rawProvenance === 'NATIVE_TEXT' || rawProvenance === 'VISION_DESCRIPTION' ? rawProvenance : null
      const chunk = knowledge?.chunkId ? chunkById.get(knowledge.chunkId) : null
      let sourceText = ''
      if (chunk && clean(chunk.text, 40).length >= 40) {
        const page = chunk.pageStart == null ? '؟' : `${chunk.pageStart}${chunk.pageEnd != null && chunk.pageEnd !== chunk.pageStart ? `–${chunk.pageEnd}` : ''}`
        sourceText = `BookChunk #${chunk.index ?? '؟'} — الصفحة ${page}\n${clean(chunk.text, 12000)}`
      } else if (knowledge && clean(knowledge.excerpt || knowledge.summary, 40).length >= 40) {
        sourceText = clean(knowledge.excerpt || knowledge.summary, 12000)
      }
      if (!sourceText) {
        skippedNoSource += 1
        continue
      }
      const provenance = provenanceOf(notes)
      // The verifier marks everything pending without a known generator, so
      // items without provenance cannot be stamped by this path at all.
      if (!provenance) {
        skippedNoProvenance += 1
        continue
      }
      verifiable.push({
        item,
        question: {
          type: item.type,
          text: item.text,
          options: parseOptions(item.options),
          correctAnswer: item.correctAnswer,
          modelAnswer: item.modelAnswer,
          sourceEvidence: item.sourceEvidence,
          qualityFlags: unitExamQualityFlags(item.qualityFlags),
          sourceIndex: 0, // set per group below
          textProvenance,
        },
        sourceText,
        provenance,
        textProvenance,
      })
    }

    // Only verifiable items reach the AI verifier, at most BATCH_CAP per press.
    const batch = verifiable.slice(0, BATCH_CAP)

    // The verifier excludes the generator's provider, so group by generator.
    const groups = new Map<string, Prepared[]>()
    for (const entry of batch) {
      const key = `${entry.provenance.provider}|||${entry.provenance.model}`
      const list = groups.get(key) || []
      list.push(entry)
      groups.set(key, list)
    }

    let stamped = 0
    let rejected = 0
    let pending = 0
    for (const [, group] of groups) {
      const questions = group.map((entry, index) => ({ ...entry.question, sourceIndex: index + 1 }))
      const sources = group.map((entry) => ({ text: entry.sourceText, textProvenance: entry.textProvenance }))
      const verified = await verifyQuestionsWithCrossProvider({
        questions,
        sources,
        generatorProvider: group[0].provenance.provider,
        generatorModel: group[0].provenance.model,
        timeBudgetMs: 120_000,
        // Reverify-only, owner-approved: the verifier may stamp OCR
        // questions it confirms. Generation never passes this flag.
        allowOcrGrounding: true,
      })
      for (let index = 0; index < group.length; index += 1) {
        const entry = group[index]
        const result = verified[index]
        if (!result) {
          pending += 1
          continue
        }
        const resultFlags = result.qualityFlags || []
        if (resultFlags.includes('SOURCE_GROUNDED')) {
          // Keep OCR_DERIVED_SOURCE visible alongside the stamp: provenance
          // is never erased, even when the verifier confirms the question.
          const merged = [...new Set([...unitExamQualityFlags(entry.item.qualityFlags), 'SOURCE_GROUNDED', ...(entry.textProvenance === 'VISION_OCR' ? ['OCR_DERIVED_SOURCE'] : [])])]
          const notes = parseNotes(entry.item.reviewNotes)
          await db.questionBankItem.update({
            where: { id: entry.item.id },
            data: {
              qualityFlags: JSON.stringify(merged),
              reviewNotes: JSON.stringify({
                ...notes,
                verifier: {
                  provider: result.verifierProvider || null,
                  model: result.verifierModel || null,
                  reason: result.verifierReason || null,
                  verifiedAt: result.verifiedAt || new Date().toISOString(),
                },
              }),
            },
          })
          stamped += 1
        } else if (result.verificationPending) {
          pending += 1
        } else {
          // Explicit AI rejection: record the reason AND mark it as
          // reverify-decided, so later presses never re-send it. Still
          // never stamped.
          const notes = parseNotes(entry.item.reviewNotes)
          await db.questionBankItem.update({
            where: { id: entry.item.id },
            data: {
              reviewNotes: JSON.stringify({
                ...notes,
                verifier: {
                  provider: result.verifierProvider || null,
                  model: result.verifierModel || null,
                  reason: result.verifierReason || null,
                  verifiedAt: result.verifiedAt || new Date().toISOString(),
                  source: 'reverify',
                },
              }),
            },
          })
          rejected += 1
        }
      }
    }

    const skipped = skippedNoSource + skippedNoProvenance + skippedOcr
    // Remaining = verifiable items still without a decisive outcome:
    // not yet sent, plus ones that came back pending (they get retried).
    // Stamped items left the set; rejected items are terminal via marker.
    const verifiableRemaining = verifiable.length - batch.length + pending
    await audit(
      { id: admin.id, name: admin.name },
      'UNIT_QUESTIONS_REVERIFY_GROUNDING',
      'Unit',
      unit.id,
      `stamped ${stamped} / rejected ${rejected} / pending ${pending} / skipped ${skipped} / alreadyRechecked ${alreadyRechecked} / verifiableRemaining ${verifiableRemaining}`,
    )
    return NextResponse.json({
      ok: true,
      unitId: unit.id,
      total: candidates.length,
      verifiableTotal: verifiable.length,
      processed: batch.length,
      stamped,
      rejected,
      pending,
      skipped,
      skippedNoSource,
      skippedNoProvenance,
      skippedOcr,
      alreadyRechecked,
      remaining: verifiableRemaining,
      verifiableRemaining,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر إعادة التحقق من أسئلة الوحدة' }, { status: 500 })
  }
}
