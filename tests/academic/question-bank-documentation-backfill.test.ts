import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Per-question independent save for the question-bank documentation backfill:
// a missing/incomplete AI row for ONE question must no longer discard the
// good rows in the same batch of 5. The good rows are saved, the bad one is
// logged per item and skipped for the rest of the run; a whole-call AI
// failure still runs the pairs retry exactly as before.

const PROGRAM_ID = 'program-doc-backfill-1'

type ItemRow = Record<string, any>
const items: ItemRow[] = []
const updates: Array<{ id: string; data: Record<string, any> }> = []
const aiCalls: any[] = []
const aiScript: Array<{ throw?: Error; rows?: any[] }> = []
const settings: Record<string, string> = {}
const warns: any[][] = []
const origWarn = console.warn

function makeItem(id: string, n: number): ItemRow {
  return {
    id, programId: PROGRAM_ID, status: 'PENDING_REVIEW', type: 'MCQ',
    text: `سؤال ${id}`, options: JSON.stringify(['أ', 'ب', 'ج', 'د']),
    correctAnswer: 'أ', sourceEvidence: `دليل ${id}`,
    sourceBookTitle: 'كتاب الاختبار', sourceLocator: 'ص 1',
    cognitiveSkill: null, difficulty: null, correctRationale: null, distractorRationales: '[]',
    knowledgeItemId: null, qualityFlags: '[]',
    createdAt: new Date(n),
  }
}

function fullRow(id: string) {
  return { id, difficulty: 'MEDIUM', cognitiveSkill: 'UNDERSTAND', correctRationale: `تفسير ${id}`, distractorRationales: [`سبب ${id} أ`, `سبب ${id} ب`] }
}

function setItems(ids: string[]) {
  items.length = 0
  ids.forEach((id, i) => items.push(makeItem(id, i + 1)))
}

function setAiScript(steps: Array<{ throw?: Error; rows?: any[] }>) {
  aiScript.length = 0
  aiScript.push(...steps)
}

function matches(row: any, where: any): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries<any>(where)) {
    if (key === 'OR') {
      if (!Array.isArray(cond) || !cond.some((c) => matches(row, c))) return false
      continue
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('not' in cond) { if (row[key] === cond.not) return false; continue }
      if ('in' in cond) { if (!cond.in.includes(row[key])) return false; continue }
      if ('notIn' in cond) { if (cond.notIn.includes(row[key])) return false; continue }
      if ('contains' in cond) { if (!String(row[key] || '').includes(cond.contains)) return false; continue }
      continue
    }
    if (row[key] !== cond) return false
  }
  return true
}

function project(row: any, select: any) {
  if (!select) return { ...row }
  const out: any = {}
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key]
  return out
}

const fakeDb: any = {
  setting: {
    findUnique: async ({ where }: any) => (settings[where.key] ? { value: settings[where.key] } : null),
    upsert: async ({ where, create, update }: any) => {
      settings[where.key] = (update?.value ?? create?.value ?? '')
      return { key: where.key, value: settings[where.key] }
    },
    deleteMany: async ({ where }: any) => {
      let n = 0
      for (const k of Object.keys(settings)) {
        if (where.key === k && (!where.value || settings[k] === where.value)) { delete settings[k]; n += 1 }
      }
      return { count: n }
    },
  },
  questionBankItem: {
    findMany: async ({ where, select, orderBy }: any = {}) => {
      const rows = items.filter((row) => matches(row, where))
      if (orderBy?.createdAt) rows.sort((a, b) => +a.createdAt - +b.createdAt)
      return rows.map((row) => project(row, select))
    },
    update: async ({ where, data }: any) => {
      const row = items.find((r) => r.id === where.id)
      if (!row) throw new Error(`item not found: ${where.id}`)
      Object.assign(row, data)
      updates.push({ id: where.id, data: { ...data } })
      return { ...row }
    },
  },
  bookKnowledgeItem: { findMany: async () => [] },
  book: { findMany: async () => [] },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
const realTextAi = await import('@/lib/text-ai')
mock.module('@/lib/text-ai', () => ({
  ...realTextAi,
  textAiCompleteJson: async (args: any) => {
    aiCalls.push(args)
    const step = aiScript.shift()
    if (!step) throw new Error('AI script exhausted')
    if (step.throw) throw step.throw
    return JSON.stringify({ items: step.rows ?? [] })
  },
}))

const { backfillQuestionBankAcademicFields } = await import('@/lib/question-bank-documentation')

function aiRequestedIds(callIndex: number): string[] {
  const text = String(aiCalls[callIndex]?.history?.[0]?.text || '')
  return JSON.parse(text).questions.map((q: any) => q.id)
}

beforeEach(() => {
  items.length = 0
  updates.length = 0
  aiCalls.length = 0
  aiScript.length = 0
  warns.length = 0
  for (const k of Object.keys(settings)) delete settings[k]
  console.warn = (...args: any[]) => { warns.push(args) }
})

afterEach(() => { console.warn = origWarn })

describe('documentation backfill: per-question independent save', () => {
  test('4 of 5 rows save the 4, no throw, filled counts only the saved fields', async () => {
    setItems(['q1', 'q2', 'q3', 'q4', 'q5'])
    setAiScript([{ rows: ['q1', 'q2', 'q3', 'q4'].map(fullRow) }])
    const res = await backfillQuestionBankAcademicFields(PROGRAM_ID)
    expect(res.filled).toBe(16)
    expect(res.remaining).toBe(1)
    expect(res.done).toBe(false)
    expect(res.locked).toBe(false)
    expect(updates.map((u) => u.id)).toEqual(['q1', 'q2', 'q3', 'q4'])
    expect(aiCalls.length).toBe(1)
    expect(aiRequestedIds(0)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'])
    const q5 = items.find((r) => r.id === 'q5')!
    expect(q5.cognitiveSkill).toBeNull()
    expect(q5.correctRationale).toBeNull()
    expect(warns.some((w) => w[0] === '[question-bank-doc] item backfill failed' && w[1]?.id === 'q5' && w[1]?.error === 'QUESTION_BANK_DOC_AI_ROWS_MISSING')).toBe(true)
  })

  test('an incomplete row (no fillable fields) is skipped like a missing row', async () => {
    setItems(['q1', 'q2', 'q3', 'q4', 'q5'])
    setAiScript([{ rows: [...['q1', 'q2', 'q3', 'q4'].map(fullRow), { id: 'q5' }] }])
    const res = await backfillQuestionBankAcademicFields(PROGRAM_ID)
    expect(res.filled).toBe(16)
    expect(res.remaining).toBe(1)
    expect(updates.map((u) => u.id)).toEqual(['q1', 'q2', 'q3', 'q4'])
    expect(aiCalls.length).toBe(1)
    expect(warns.some((w) => w[0] === '[question-bank-doc] item backfill failed' && w[1]?.id === 'q5' && w[1]?.error === 'QUESTION_BANK_DOC_AI_ROW_INCOMPLETE')).toBe(true)
  })

  test('a whole-call AI failure still runs the pairs retry and saves nothing', async () => {
    setItems(['q1', 'q2', 'q3', 'q4', 'q5'])
    const err = new Error('AI_DEADLINE_EXCEEDED')
    setAiScript([{ throw: err }, { throw: err }, { throw: err }, { throw: err }])
    const res = await backfillQuestionBankAcademicFields(PROGRAM_ID)
    expect(res.filled).toBe(0)
    expect(res.remaining).toBe(5)
    expect(updates.length).toBe(0)
    expect(aiCalls.length).toBe(4)
    expect(aiRequestedIds(0)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(aiRequestedIds(1)).toEqual(['q1', 'q2'])
    expect(aiRequestedIds(2)).toEqual(['q3', 'q4'])
    expect(aiRequestedIds(3)).toEqual(['q5'])
    expect(warns.some((w) => w[0] === '[question-bank-doc] batch backfill failed')).toBe(true)
  })

  test('pairs retry also saves per question after a whole-call batch failure', async () => {
    setItems(['q1', 'q2', 'q3', 'q4', 'q5'])
    setAiScript([
      { throw: new Error('AI_DEADLINE_EXCEEDED') },
      { rows: [fullRow('q1')] },
      { rows: [fullRow('q3')] },
      { rows: [fullRow('q5')] },
    ])
    const res = await backfillQuestionBankAcademicFields(PROGRAM_ID)
    expect(res.filled).toBe(12)
    expect(res.remaining).toBe(2)
    expect(updates.map((u) => u.id)).toEqual(['q1', 'q3', 'q5'])
    expect(aiCalls.length).toBe(4)
  })
})
