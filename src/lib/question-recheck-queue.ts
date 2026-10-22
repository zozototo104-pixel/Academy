import { db } from '@/lib/db'

// D3.2a: طبقة بيانات طابور إعادة التدقيق التلقائية المحدودة — بيانات
// فقط، بلا مشغّل وبلا أي كاتب خارجي بعد (المشغّل المحدود هو D3.2b).
// قواعد صارمة:
// - التوصية فقط: إكمال مهمة يكتب نتيجتها على المهمة نفسها، ولا توجد
//   في هذه الطبقة أي كتابة على السؤال (حالته وأعلامه لا تُلمس أبدًا).
// - الأهلية: فقط سؤال بحالة PENDING_REVIEW (لم يُحسم بقبول/رفض نهائي).
// - لا حلقة لا نهائية: idempotency (لا مهمة نشطة مكررة لنفس السبب)
//   + عدّاد محاولات بسقف MAX_AUTO_RECHECKS لكل سؤال.

export const MAX_AUTO_RECHECKS = 3

function activeDedupKey(questionId: string, reason: RecheckReason): string {
  return `${questionId}:${reason}`
}

export const RECHECK_REASONS = ['REVIEW_PROFILE_CHANGED', 'NEW_EVIDENCE_AVAILABLE', 'MANUAL_ADMIN_RECHECK'] as const
export type RecheckReason = (typeof RECHECK_REASONS)[number]

export type RecheckTaskStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'

export interface RecheckRecommendation {
  valid: boolean
  verifierProvider: string | null
  verifierModel: string | null
  reason: string
  checkedAt: string
}

export interface RecheckTaskRow {
  id: string
  questionId: string
  reason: RecheckReason
  status: RecheckTaskStatus
  profileVersion: string | null
  recommendation: RecheckRecommendation | null
  error: string | null
  createdAt: Date
  claimedAt: Date | null
  finishedAt: Date | null
}

export type EnqueueRecheckResult =
  | { enqueued: true; taskId: string }
  | { enqueued: false; reason: 'not-found' | 'not-eligible' | 'already-queued' | 'cap-reached' }

interface RecheckQueueStore {
  getQuestion(id: string): Promise<{ id: string; status: string } | null>
  countTasks(questionId: string): Promise<number>
  findActiveTask(questionId: string, reason: RecheckReason): Promise<{ id: string } | null>
  createTask(data: {
    questionId: string
    reason: RecheckReason
    activeDedupKey: string
    profileVersion: string | null
  }): Promise<{ id: string }>
  listPending(limit: number): Promise<RecheckTaskRow[]>
  markRunning(id: string, now: Date): Promise<boolean>
  finishTask(id: string, status: 'DONE' | 'FAILED', payload: { recommendation?: RecheckRecommendation; error?: string }, now: Date): Promise<void>
}

const prismaStore: RecheckQueueStore = {
  async getQuestion(id) {
    return db.questionBankItem.findUnique({ where: { id }, select: { id: true, status: true } })
  },
  async countTasks(questionId) {
    return db.questionRecheckTask.count({ where: { questionId } })
  },
  async findActiveTask(questionId, reason) {
    return db.questionRecheckTask.findFirst({
      where: { questionId, reason, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    })
  },
  async createTask(data) {
    return db.questionRecheckTask.create({ data: data as never, select: { id: true } })
  },
  async listPending(limit) {
    const rows = await db.questionRecheckTask.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    return rows as unknown as RecheckTaskRow[]
  },
  async markRunning(id, now) {
    const res = await db.questionRecheckTask.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'RUNNING', claimedAt: now },
    })
    return res.count === 1
  },
  async finishTask(id, status, payload, now) {
    await db.questionRecheckTask.updateMany({
      where: { id, status: 'RUNNING' },
      data: {
        status,
        activeDedupKey: null,
        finishedAt: now,
        ...(payload.recommendation ? { recommendation: payload.recommendation as never } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      },
    })
  },
}

let store: RecheckQueueStore = prismaStore

export function __setRecheckQueueStoreForTests(next: RecheckQueueStore | null) {
  store = next ?? prismaStore
}

// أهلية إعادة التدقيق: السؤال موجود ولم يُحسم نهائيًا.
export function isRecheckEligibleStatus(status: string): boolean {
  return status === 'PENDING_REVIEW'
}

export async function enqueueQuestionRecheck(input: {
  questionId: string
  reason: RecheckReason
  profileVersion?: string | null
}): Promise<EnqueueRecheckResult> {
  const question = await store.getQuestion(input.questionId)
  if (!question) return { enqueued: false, reason: 'not-found' }
  if (!isRecheckEligibleStatus(question.status)) return { enqueued: false, reason: 'not-eligible' }
  const active = await store.findActiveTask(input.questionId, input.reason)
  if (active) return { enqueued: false, reason: 'already-queued' }
  const total = await store.countTasks(input.questionId)
  if (total >= MAX_AUTO_RECHECKS) return { enqueued: false, reason: 'cap-reached' }
  try {
    const created = await store.createTask({
      questionId: input.questionId,
      reason: input.reason,
      activeDedupKey: activeDedupKey(input.questionId, input.reason),
      profileVersion: input.profileVersion ?? null,
    })
    return { enqueued: true, taskId: created.id }
  } catch (err) {
    // سباق إدراج متزامن: الفهرس الفريد الجزئي على المهام النشطة
    // (D3.2b) يرفض الثاني — نترجمه لنفس نتيجة الفحص المنطقي.
    if ((err as { code?: string } | null)?.code === 'P2002') return { enqueued: false, reason: 'already-queued' }
    throw err
  }
}

// مطالبة المهام المعلّقة لتشغيلة محدودة (يستخدمها مشغّل D3.2b):
// كل مهمة تُطالب مرة واحدة فقط (PENDING → RUNNING بشرط الحالة).
export async function claimNextRecheckTasks(limit: number): Promise<RecheckTaskRow[]> {
  const capped = Math.max(1, Math.min(50, Math.floor(limit) || 1))
  const pending = await store.listPending(capped)
  const claimed: RecheckTaskRow[] = []
  const now = new Date()
  for (const task of pending) {
    if (await store.markRunning(task.id, now)) {
      claimed.push({ ...task, status: 'RUNNING', claimedAt: now })
    }
  }
  return claimed
}

// إكمال بموجب توصية فقط — لا يغيّر السؤال إطلاقًا.
export async function completeRecheckTask(taskId: string, recommendation: RecheckRecommendation): Promise<void> {
  await store.finishTask(taskId, 'DONE', { recommendation }, new Date())
}

export async function failRecheckTask(taskId: string, error: string): Promise<void> {
  await store.finishTask(taskId, 'FAILED', { error: String(error).slice(0, 500) }, new Date())
}
