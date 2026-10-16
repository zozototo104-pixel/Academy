import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

export type AiUsageTaskType = 'CHAT' | 'ANALYSIS' | 'GENERATION' | 'GRADING' | 'VISION' | 'LONG_CONTEXT' | 'REVIEW' | 'WHATSAPP' | string

function utcDayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function approxTokens(text: string) {
  return Math.max(0, Math.ceil(String(text || '').length / 4))
}

export function estimateAiCostCents(inputTokens: number, outputTokens: number, provider?: string, model?: string) {
  const configured = Number(process.env.AI_DEFAULT_CALL_COST_CENTS)
  if (Number.isFinite(configured) && configured >= 0) return Math.ceil(configured)
  const p = String(provider || '').toUpperCase()
  const m = String(model || '').toLowerCase()
  const perThousandCents = p === 'OPENAI' || /gpt|claude|paid/.test(m) ? 1 : 0.1
  return Math.max(1, Math.ceil(((Math.max(0, inputTokens) + Math.max(0, outputTokens)) / 1000) * perThousandCents))
}

async function dailyCapCents() {
  const raw = await getSetting('AI_USER_DAILY_COST_CAP_CENTS').catch(() => process.env.AI_USER_DAILY_COST_CAP_CENTS || '')
  const cap = Number(raw || process.env.AI_USER_DAILY_COST_CAP_CENTS || 0)
  return Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0
}

export async function getTodayAiCostCents(userId: string) {
  const dayStart = utcDayStart()
  const rows = await db.aiUsageLog.findMany({ where: { userId, createdAt: { gte: dayStart } }, select: { costCents: true } })
  return rows.reduce((sum, row) => sum + Math.max(0, Number(row.costCents || 0)), 0)
}

export async function enforceAiUserDailyCostCap(input: { userId?: string | null; role?: string | null; estimatedCostCents?: number }) {
  if (!input.userId) return
  const role = input.role || (await db.user.findUnique({ where: { id: input.userId }, select: { role: true } }).catch(() => null))?.role
  if (String(role || '').toUpperCase() === 'ADMIN') return
  const cap = await dailyCapCents()
  if (cap <= 0) return
  const spent = await getTodayAiCostCents(input.userId)
  const estimated = Math.max(1, Math.ceil(input.estimatedCostCents || 1))
  if (spent + estimated > cap) {
    const error: any = new Error('تجاوزت سقف استخدام الذكاء الاصطناعي اليومي لهذا اليوم. جرّب غداً أو تواصل مع الإدارة إذا كنت تحتاج تمديداً.')
    error.status = 429
    error.code = 'AI_USER_DAILY_COST_CAP_EXCEEDED'
    error.capCents = cap
    error.spentCents = spent
    throw error
  }
}

export async function recordAiUsage(input: {
  userId?: string | null
  provider: string
  model: string
  taskType?: AiUsageTaskType
  inputText?: string
  outputText?: string
  inputTokens?: number
  outputTokens?: number
  costCents?: number
}) {
  const inputTokens = Math.max(0, Math.ceil(input.inputTokens ?? approxTokens(input.inputText || '')))
  const outputTokens = Math.max(0, Math.ceil(input.outputTokens ?? approxTokens(input.outputText || '')))
  const costCents = Math.max(0, Math.ceil(input.costCents ?? estimateAiCostCents(inputTokens, outputTokens, input.provider, input.model)))
  return db.aiUsageLog.create({
    data: {
      userId: input.userId || null,
      provider: String(input.provider || 'UNKNOWN').slice(0, 80),
      model: String(input.model || 'unknown').slice(0, 180),
      taskType: String(input.taskType || 'CHAT').slice(0, 80),
      inputTokens,
      outputTokens,
      costCents,
    },
  }).catch((error) => {
    console.error('[ai-usage] failed to record usage', error)
    return null
  })
}

export function estimatePromptTokens(system: string, history: Array<{ text?: string }>) {
  return approxTokens(`${system || ''}\n${history.map((m) => m.text || '').join('\n')}`)
}
