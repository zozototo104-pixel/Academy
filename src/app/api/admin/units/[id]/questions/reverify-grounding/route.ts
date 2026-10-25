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
// existed). Only questions the existing second-provider verifier confirms
// against original book text get stamped; everything else is left untouched.
// Bounded per call: the dialog button can be pressed again for the rest.
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
// Body: {} — the unit id comes from the path. Re-runs the existing verifier
// over the unit's APPROVED questions that lack SOURCE_GROUNDED and stamps
// only the ones the verifier confirms against original book text.
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
    const take = candidates.slice(0, BATCH_CAP)
    const remaining = candidates.length - take.length

    const knowledgeIds = [...new Set(take.map((item) => item.knowledgeItemId).filter((v): v is string => Boolean(v)))]
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

    type Prepared = { item: (typeof take)[number]; question: VerifiableQuestion; sourceText: string; provenance: { provider: string; model: string } }
    const prepared: Prepared[] = []
    let skippedNoSource = 0
    let skippedNoProvenance = 0
    let skippedOcr = 0

    for (const item of take) {
      const knowledge = item.knowledgeItemId ? knowledgeById.get(item.knowledgeItemId) : null
      // OCR-derived sources can never carry SOURCE_GROUNDED by construction
      // (the verifier strips it for VISION_OCR), so do not burn AI calls on them.
      if (knowledge?.textProvenance === 'VISION_OCR') {
        skippedOcr += 1
        continue
      }
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
      const notes = parseNotes(item.reviewNotes)
      const provenance = provenanceOf(notes)
      // The verifier marks everything pending without a known generator, so
      // items without provenance cannot be stamped by this path at all.
      if (!provenance) {
        skippedNoProvenance += 1
        continue
      }
      prepared.push({
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
        },
        sourceText,
        provenance,
      })
    }

    // The verifier excludes the generator's provider, so group by generator.
    const groups = new Map<string, Prepared[]>()
    for (const entry of prepared) {
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
      const sources = group.map((entry) => ({ text: entry.sourceText }))
      const verified = await verifyQuestionsWithCrossProvider({
        questions,
        sources,
        generatorProvider: group[0].provenance.provider,
        generatorModel: group[0].provenance.model,
        timeBudgetMs: 120_000,
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
          const merged = [...new Set([...unitExamQualityFlags(entry.item.qualityFlags), 'SOURCE_GROUNDED'])]
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
          // Explicit rejection: record the reason, but never stamp.
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
                },
              }),
            },
          })
          rejected += 1
        }
      }
    }

    const skipped = skippedNoSource + skippedNoProvenance + skippedOcr
    await audit(
      { id: admin.id, name: admin.name },
      'UNIT_QUESTIONS_REVERIFY_GROUNDING',
      'Unit',
      unit.id,
      `stamped ${stamped} / rejected ${rejected} / pending ${pending} / skipped ${skipped} / remaining ${remaining}`,
    )
    return NextResponse.json({
      ok: true,
      unitId: unit.id,
      total: candidates.length,
      processed: take.length,
      stamped,
      rejected,
      pending,
      skipped,
      skippedNoSource,
      skippedNoProvenance,
      skippedOcr,
      remaining,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر إعادة التحقق من أسئلة الوحدة' }, { status: 500 })
  }
}
