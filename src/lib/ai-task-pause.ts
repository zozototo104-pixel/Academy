import { db } from '@/lib/db'

export type AiTaskPauseKind = 'QUESTION_BANK' | 'PROGRAM_EXAM'
export type AiTaskPausePayload = { code: string; reason: string; retryAt?: string | null; pausedAt?: string }

function pauseKey(kind: AiTaskPauseKind, scopeId: string): string {
  return `AI_TASK_PAUSE:${kind}:${scopeId}`
}

export async function setAiTaskPause(kind: AiTaskPauseKind, scopeId: string, payload: AiTaskPausePayload): Promise<AiTaskPausePayload> {
  const value = { ...payload, retryAt: payload.retryAt || null, pausedAt: payload.pausedAt || new Date().toISOString() }
  try {
    await db.setting.upsert({
      where: { key: pauseKey(kind, scopeId) },
      create: { key: pauseKey(kind, scopeId), value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    })
  } catch (error) {
    console.warn('setAiTaskPause failed; continuing without persistent pause state', { kind, scopeId, error })
  }
  return value
}

export async function getAiTaskPause(kind: AiTaskPauseKind, scopeId: string): Promise<AiTaskPausePayload | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: pauseKey(kind, scopeId) } })
    if (!row?.value) return null
    try {
      const parsed = JSON.parse(row.value)
      return {
        code: String(parsed.code || 'AI_TASK_PAUSED'),
        reason: String(parsed.reason || 'Paused'),
        retryAt: parsed.retryAt || null,
        pausedAt: parsed.pausedAt || null,
      }
    } catch {
      return null
    }
  } catch (error) {
    console.warn('getAiTaskPause failed; treating task as not paused', { kind, scopeId, error })
    return null
  }
}

export async function clearAiTaskPause(kind: AiTaskPauseKind, scopeId: string): Promise<void> {
  try {
    await db.setting.delete({ where: { key: pauseKey(kind, scopeId) } })
  } catch (error) {
    console.warn('clearAiTaskPause failed; continuing without throwing', { kind, scopeId, error })
  }
}
