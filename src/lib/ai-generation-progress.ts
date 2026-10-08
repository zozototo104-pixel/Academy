import { db } from '@/lib/db'
import { normalizeArabic } from '@/lib/arabic-normalize'
import { randomUUID } from 'node:crypto'

export type AiGenerationProgressType = 'QUESTION_BANK' | 'PROGRAM_EXAM' | 'KNOWLEDGE_BANK'

export type AiGenerationProgress = {
  requested: number
  saved: number
  failedBatches: number
  lastError: string | null
  updatedAt: string
}

export function aiGenerationProgressKey(type: AiGenerationProgressType, programId: string, semester: number | string | null | undefined): string {
  return `AI_GEN_PROGRESS:${type}:${programId}:${semester ?? 'ALL'}`
}

export function questionDuplicateKey(text: unknown, sourceRef: unknown): string {
  return `${normalizeArabic(text)}::${String(sourceRef ?? '').trim()}`
}

function normalizeProgress(raw: unknown): AiGenerationProgress | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    return {
      requested: Math.max(0, Number((parsed as any).requested || 0) || 0),
      saved: Math.max(0, Number((parsed as any).saved || 0) || 0),
      failedBatches: Math.max(0, Number((parsed as any).failedBatches || 0) || 0),
      lastError: (parsed as any).lastError ? String((parsed as any).lastError).slice(0, 500) : null,
      updatedAt: String((parsed as any).updatedAt || new Date().toISOString()),
    }
  } catch {
    return null
  }
}

export async function getAiGenerationProgress(type: AiGenerationProgressType, programId: string, semester?: number | string | null): Promise<AiGenerationProgress | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: aiGenerationProgressKey(type, programId, semester) } })
    return normalizeProgress(row?.value || null)
  } catch (error) {
    console.warn('getAiGenerationProgress failed; continuing without stored progress', { type, programId, semester, error })
    return null
  }
}

export async function setAiGenerationProgress(type: AiGenerationProgressType, programId: string, semester: number | string | null | undefined, patch: Partial<AiGenerationProgress>): Promise<AiGenerationProgress> {
  const current = await getAiGenerationProgress(type, programId, semester)
  const next: AiGenerationProgress = {
    requested: Math.max(0, Number(patch.requested ?? current?.requested ?? 0) || 0),
    saved: Math.max(0, Number(patch.saved ?? current?.saved ?? 0) || 0),
    failedBatches: Math.max(0, Number(patch.failedBatches ?? current?.failedBatches ?? 0) || 0),
    lastError: patch.lastError === undefined ? current?.lastError ?? null : patch.lastError ? String(patch.lastError).slice(0, 500) : null,
    updatedAt: new Date().toISOString(),
  }
  try {
    await db.setting.upsert({
      where: { key: aiGenerationProgressKey(type, programId, semester) },
      create: { key: aiGenerationProgressKey(type, programId, semester), value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    })
  } catch (error) {
    console.warn('setAiGenerationProgress failed; continuing without stored progress', { type, programId, semester, error })
  }
  return next
}
