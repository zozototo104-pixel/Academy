import { db } from '@/lib/db'

export type AiTaskPauseKind = 'QUESTION_BANK' | 'PROGRAM_EXAM'
export type AiTaskPausePayload = { code: string; reason: string; retryAt?: string | null; pausedAt?: string }

type AiTaskPauseStore = {
  upsert(key: string, value: string): Promise<void>
  find(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

let injectedStore: AiTaskPauseStore | null = null

function store(): AiTaskPauseStore {
  return injectedStore || {
    async upsert(key, value) {
      await db.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
    },
    async find(key) {
      const row = await db.setting.findUnique({ where: { key } })
      return row?.value || null
    },
    async delete(key) {
      await db.setting.delete({ where: { key } })
    },
  }
}

export function __setAiTaskPauseStoreForTests(testStore: AiTaskPauseStore | null) {
  injectedStore = testStore
}

function pauseKey(kind: AiTaskPauseKind, scopeId: string): string {
  return `AI_TASK_PAUSE:${kind}:${scopeId}`
}

export async function setAiTaskPause(kind: AiTaskPauseKind, scopeId: string, payload: AiTaskPausePayload): Promise<AiTaskPausePayload> {
  const value = { ...payload, retryAt: payload.retryAt || null, pausedAt: payload.pausedAt || new Date().toISOString() }
  try {
    await store().upsert(pauseKey(kind, scopeId), JSON.stringify(value))
  } catch (error) {
    console.warn('setAiTaskPause failed; continuing without persistent pause state', { kind, scopeId, error })
  }
  return value
}

export async function getAiTaskPause(kind: AiTaskPauseKind, scopeId: string): Promise<AiTaskPausePayload | null> {
  try {
    const value = await store().find(pauseKey(kind, scopeId))
    if (!value) return null
    try {
      const parsed = JSON.parse(value)
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
    await store().delete(pauseKey(kind, scopeId))
  } catch (error) {
    console.warn('clearAiTaskPause failed; continuing without throwing', { kind, scopeId, error })
  }
}
