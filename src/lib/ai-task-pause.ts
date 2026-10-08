import { db } from '@/lib/db'

export type AiTaskPauseKind = 'QUESTION_BANK' | 'PROGRAM_EXAM'
export type AiTaskPausePayload = { code: string; reason: string; retryAt?: string | null; pausedAt?: string }

function pauseKey(kind: AiTaskPauseKind, scopeId: string): string {
  return `AI_TASK_PAUSE:${kind}:${scopeId}`
}

export async function setAiTaskPause(kind: AiTaskPauseKind, scopeId: string, payload: AiTaskPausePayload): Promise<AiTaskPausePayload> {
  const value = { ...payload, retryAt: payload.retryAt || null, pausedAt: payload.pausedAt || new Date().toISOString() }
  await db.setting.upsert({
    where: { key: pauseKey(kind, scopeId) },
    create: { key: pauseKey(kind, scopeId), value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
  return value
}

export async function getAiTaskPause(kind: AiTaskPauseKind, scopeId: string): Promise<AiTaskPausePayload | null> {
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
}

export async function clearAiTaskPause(kind: AiTaskPauseKind, scopeId: string): Promise<void> {
  await db.setting.delete({ where: { key: pauseKey(kind, scopeId) } }).catch(() => {})
}
