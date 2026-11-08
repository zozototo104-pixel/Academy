import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/notify', () => ({
  audit: async () => {},
  notify: async () => {},
  notifyAdmins: async () => {},
}))

const {
  evaluateClosureRight,
  getSemesterDecision,
  loadSemesterPeriod,
  markSemesterDecided,
  recordSemesterIntent,
  tryMatureSemesterRaise,
  withdrawSemesterRaise,
} = await import('../../src/lib/semester-decision')

// سجل قرار الطالب وحق الإغلاق: مصدر قرار واحد لكل (التحاق × فصل)،
// لا موافقة ضمنية من علامة جاهزية قديمة، لا إغلاق لفصل مفتوح بلا
// رفع ناضج أو نهاية فترة، والسحب محفوظ قبل القرار وضمن الفترة.

const CREATED = new Date('2026-01-01T00:00:00Z')
const OPEN_NOW = new Date('2026-01-20T00:00:00Z') // داخل نافذة الفصل الأول (45 يومًا من 90)
const ENDED_NOW = new Date('2026-03-01T00:00:00Z') // بعد نهاية الفصل الأول، داخل الثاني

function makeClient(opts?: { approval?: any; state?: any; examReadiness?: string | null }) {
  const decisions = new Map<string, any>()
  const key = (enrollmentId: string, semester: number) => `${enrollmentId}:${semester}`
  const enrollment = {
    id: 'enr-1',
    userId: 'user-1',
    programId: 'prog-1',
    createdAt: CREATED,
    extensionDays: 0,
    examReadiness: opts?.examReadiness ?? null,
    program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
  }
  const units = [
    { id: 'u1', semester: 1, order: 1 },
    { id: 'u2', semester: 1, order: 2 },
    { id: 'u3', semester: 2, order: 1 },
  ]
  const client: any = {
    enrollment: {
      findUnique: async ({ where }: any) => (where.id === 'enr-1' ? enrollment : null),
    },
    unit: { findMany: async () => units },
    semesterDecision: {
      findUnique: async ({ where }: any) =>
        decisions.get(key(where.enrollmentId_semester.enrollmentId, where.enrollmentId_semester.semester)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const k = key(where.enrollmentId_semester.enrollmentId, where.enrollmentId_semester.semester)
        const existing = decisions.get(k)
        const row = existing ? { ...existing, ...update } : { id: `dec-${decisions.size + 1}`, ...create }
        decisions.set(k, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const k = key(where.enrollmentId_semester.enrollmentId, where.enrollmentId_semester.semester)
        const existing = decisions.get(k)
        if (!existing) throw new Error('not found')
        const row = { ...existing, ...data }
        decisions.set(k, row)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const k = key(where.enrollmentId, where.semester)
        let existing = decisions.get(k)
        if (!existing) return { count: 0 }
        // سباق مُحاكى: التبديل يحدث قبل تقييم شرط الحالة، كما في قاعدة حقيقية
        if ((opts as any)?.raceOnce && !(opts as any).__raced) {
          ;(opts as any).__raced = true
          ;(opts as any).raceOnce(existing, decisions, k)
          existing = decisions.get(k)
        }
        const allowed: string[] = typeof where.status === 'string'
          ? [where.status] : (where.status?.in ?? [])
        if (!allowed.includes(existing.status)) return { count: 0 }
        if (where.raiseSource && where.raiseSource !== existing.raiseSource) return { count: 0 }
        decisions.set(k, { ...existing, ...data })
        return { count: 1 }
      },
      create: async ({ data }: any) => {
        const row = { id: `dec-${decisions.size + 1}`, ...data }
        decisions.set(key(data.enrollmentId, data.semester), row)
        return row
      },
    },
    semesterResultApproval: {
      findUnique: async () => opts?.approval ?? null,
    },
    enrollmentSemesterState: {
      findUnique: async () => opts?.state ?? null,
    },
  }
  return { client, decisions }
}

describe('evaluateClosureRight — جدول حق الإغلاق', () => {
  test('رفع ناضج من الطالب يمنح الحق بمصدر الطالب', () => {
    const r = evaluateClosureRight({ decision: { status: 'RAISED', raiseSource: 'STUDENT' }, periodEnded: false })
    expect(r.allowed).toBe(true)
    expect(r.source).toBe('STUDENT')
  })
  test('نهاية الفترة تمنح الحق ولو بلا أي سجل', () => {
    const r = evaluateClosureRight({ decision: null, periodEnded: true })
    expect(r.allowed).toBe(true)
    expect(r.source).toBe('DEADLINE')
  })
  test('رفع المهلة لا يُنسب للطالب، والتمديد يسحب حق الإغلاق الآلي حتى ينتهي', () => {
    const deadline = { status: 'RAISED', raiseSource: 'DEADLINE' }
    const afterEnd = evaluateClosureRight({ decision: deadline, periodEnded: true })
    expect(afterEnd.allowed).toBe(true)
    expect(afterEnd.source).toBe('DEADLINE')
    const afterExtension = evaluateClosureRight({ decision: deadline, periodEnded: false })
    expect(afterExtension.allowed).toBe(false)
    expect(afterExtension.source).toBeNull()
  })
  test('نية غير ناضجة لا تمنح الحق أثناء الفترة', () => {
    const r = evaluateClosureRight({ decision: { status: 'INTENT' }, periodEnded: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('INTENT_NOT_MATURE')
  })
  test('طلب مسحوب لا يمنح الحق أثناء الفترة', () => {
    const r = evaluateClosureRight({ decision: { status: 'WITHDRAWN' }, periodEnded: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('WITHDRAWN')
  })
  test('بلا سجل وبلا نهاية فترة: بانتظار الطالب', () => {
    const r = evaluateClosureRight({ decision: null, periodEnded: false })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('AWAITING_STUDENT')
  })
})

describe('loadSemesterPeriod — نافذة الفصل من تقسيم المدة القائم', () => {
  test('داخل الفترة لا تُعد منتهية، وبعدها تُعد منتهية', async () => {
    const { client } = makeClient()
    const base = {
      programId: 'prog-1',
      enrollmentCreatedAt: CREATED,
      extensionDays: 0,
      program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
      semester: 1,
    }
    const open = await loadSemesterPeriod(client, { ...base, now: OPEN_NOW })
    expect(open.ended).toBe(false)
    expect(open.endAt?.toISOString()).toBe('2026-02-15T00:00:00.000Z')
    const ended = await loadSemesterPeriod(client, { ...base, now: ENDED_NOW })
    expect(ended.ended).toBe(true)
  })
  test('أيام التمديد المعتمدة تطيل الفترة', async () => {
    const { client } = makeClient()
    const r = await loadSemesterPeriod(client, {
      programId: 'prog-1',
      enrollmentCreatedAt: CREATED,
      extensionDays: 40,
      program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
      semester: 1,
      now: ENDED_NOW,
    })
    // (90+40)/2 = 65 يومًا للفصل الأول: ينتهي 2026-03-07 — لم ينتهِ بعد
    expect(r.ended).toBe(false)
    expect(r.endAt?.toISOString()).toBe('2026-03-07T00:00:00.000Z')
  })
})

describe('recordSemesterIntent — تسجيل اختيار الطالب', () => {
  test('إنهاء مبكر غير ناضج يُحفظ نيةً فقط بلا رفع', async () => {
    const { client } = makeClient()
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', scoreSnapshot: 61.5, maturity: { mature: false, score: null }, now: OPEN_NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.decision?.status).toBe('INTENT')
      expect(r.decision?.raiseSource).toBeNull()
      expect(r.decision?.scoreAtIntent).toBe(61.5)
      expect(r.decision?.scoreAtRaise).toBeNull()
    }
  })
  test('إنهاء مبكر ناضج يرفع فورًا بلقطة نتيجته', async () => {
    const { client } = makeClient()
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', scoreSnapshot: 61.5, maturity: { mature: true, score: 63 }, now: OPEN_NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.decision?.status).toBe('RAISED')
      expect(r.decision?.raiseSource).toBe('STUDENT')
      expect(r.decision?.scoreAtRaise).toBe(63)
    }
  })
  test('تكرار نفس الاختيار الناضج لا يغيّر وقت الرفع (منع التكرار)', async () => {
    const { client } = makeClient()
    const first = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 63 }, now: OPEN_NOW,
    })
    const second = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 70 }, now: new Date('2026-01-25T00:00:00Z'),
    })
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.decision?.raisedAt).toBe(first.decision?.raisedAt)
      expect(second.decision?.scoreAtRaise).toBe(63)
    }
  })
  test('اختيار الاستكمال بعد نية مبكرة يلغي النية', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: false, score: null }, now: OPEN_NOW,
    })
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'CONTINUE', now: OPEN_NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.decision?.intent).toBe('CONTINUE')
      expect(r.decision?.status).toBe('NONE')
    }
  })
  test('اختيار الاستكمال لا يلغي رفعًا ناضجًا — السحب له طريقه', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'CONTINUE', now: OPEN_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SEMESTER_ALREADY_RAISED')
  })
  test('لا اختيار بعد انتهاء فترة الفصل', async () => {
    const { client } = makeClient()
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: ENDED_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SEMESTER_PERIOD_ENDED')
  })
  test('لا اختيار بعد اعتماد الإدارة', async () => {
    const { client } = makeClient({ approval: { id: 'ap-1', status: 'APPROVED' } })
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SEMESTER_ALREADY_DECIDED')
  })
  test('لا موافقة بأثر رجعي: ضغطة جاهز قديمة لا تصنع أي قرار', async () => {
    const { client } = makeClient({ examReadiness: '[1]' })
    const decision = await getSemesterDecision(client, 'enr-1', 1)
    expect(decision).toBeNull()
    const closure = evaluateClosureRight({ decision, periodEnded: false })
    expect(closure.allowed).toBe(false)
    expect(closure.reason).toBe('AWAITING_STUDENT')
  })
})

describe('tryMatureSemesterRaise + withdrawSemesterRaise', () => {
  test('النية تنضج عند اكتمال الشروط وتبقى نية قبلها', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', scoreSnapshot: 55, maturity: { mature: false, score: null }, now: OPEN_NOW,
    })
    const early = await tryMatureSemesterRaise(client, { enrollmentId: 'enr-1', semester: 1, maturity: { mature: false, score: null } })
    expect(early?.status).toBe('INTENT')
    const matured = await tryMatureSemesterRaise(client, {
      enrollmentId: 'enr-1', semester: 1, maturity: { mature: true, score: 58 }, now: OPEN_NOW,
    })
    expect(matured?.status).toBe('RAISED')
    expect(matured?.raiseSource).toBe('STUDENT')
    expect(matured?.scoreAtRaise).toBe(58)
  })
  test('السحب متاح للرفع الناضج ما دامت الفترة مفتوحة ولا قرار', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    const r = await withdrawSemesterRaise(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: OPEN_NOW,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision?.status).toBe('WITHDRAWN')
    const closure = evaluateClosureRight({ decision: r.ok ? r.decision : null, periodEnded: false })
    expect(closure.allowed).toBe(false)
  })
  test('السحب بعد انتهاء الفترة مرفوض — لا يبعث الوقت من جديد', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    const r = await withdrawSemesterRaise(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: ENDED_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SEMESTER_PERIOD_ENDED')
  })
  test('السحب بلا طلب قائم مرفوض، وبعد قرار الإدارة مرفوض', async () => {
    const { client } = makeClient()
    const none = await withdrawSemesterRaise(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: OPEN_NOW,
    })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.code).toBe('NO_ACTIVE_RAISE')
    const decided = makeClient({ approval: { id: 'ap-1', status: 'APPROVED' } })
    const r = await withdrawSemesterRaise(decided.client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: OPEN_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SEMESTER_ALREADY_DECIDED')
  })
})

describe('markSemesterDecided — ختم القرار عند اعتماد الإدارة', () => {
  test('سجل قائم يتحول إلى مُقرَّر', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    await markSemesterDecided(client, { enrollmentId: 'enr-1', semester: 1, periodEnded: false, now: OPEN_NOW })
    const d = await getSemesterDecision(client, 'enr-1', 1)
    expect(d?.status).toBe('DECIDED')
    expect(d?.raiseSource).toBe('STUDENT')
  })
  test('بلا سجل وبنهاية الفترة يُنشأ سجل مصدره المهلة', async () => {
    const { client } = makeClient()
    await markSemesterDecided(client, {
      enrollmentId: 'enr-1', semester: 1, periodEnded: true,
      periodEndAt: new Date('2026-02-15T00:00:00Z'), now: ENDED_NOW,
    })
    const d = await getSemesterDecision(client, 'enr-1', 1)
    expect(d?.status).toBe('DECIDED')
    expect(d?.raiseSource).toBe('DEADLINE')
  })
})

describe('تحصين التزامن والنطاق والربط (إغلاق ملاحظات المرحلة 1)', () => {
  test('طالب آخر لا يملك التسجيل: الرفض كأن التسجيل غير موجود', async () => {
    const { client } = makeClient()
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-OTHER', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ENROLLMENT_NOT_FOUND')
  })
  test('فصل خارج نطاق البرنامج مرفوض في التسجيل والسحب', async () => {
    const { client } = makeClient()
    const r = await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 3,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_SEMESTER')
    const w = await withdrawSemesterRaise(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 3, now: OPEN_NOW,
    })
    expect(w.ok).toBe(false)
    if (!w.ok) expect(w.code).toBe('INVALID_SEMESTER')
  })
  test('طلب مسحوب لا يبعثه تصحيح متأخر أبدًا', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: false, score: null }, now: OPEN_NOW,
    })
    await withdrawSemesterRaise(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: OPEN_NOW,
    })
    const after = await tryMatureSemesterRaise(client, {
      enrollmentId: 'enr-1', semester: 1, maturity: { mature: true, score: 80 }, now: OPEN_NOW,
    })
    expect(after?.status).toBe('WITHDRAWN')
  })
  test('سباق: قرار إدارة يهبط أثناء السحب — السحب يرفض ولا يطغى على القرار', async () => {
    const raced = makeClient({
      raceOnce: (existing: any, decisions: Map<string, any>, k: string) => {
        decisions.set(k, { ...existing, status: 'DECIDED', decidedAt: new Date() })
      },
    } as any)
    await recordSemesterIntent(raced.client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    const w = await withdrawSemesterRaise(raced.client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1, now: OPEN_NOW,
    })
    // التحديث المشروط لم يجد RAISED (سبقه القرار) فرفض بدل الكتابة فوقه
    expect(w.ok).toBe(false)
    const d = await getSemesterDecision(raced.client, 'enr-1', 1)
    expect(d?.status).toBe('DECIDED')
  })
  test('فشل حفظ ختم القرار ينتشر ولا يُبتلع (الاعتماد يجب أن يرتد)', async () => {
    const { client } = makeClient()
    await recordSemesterIntent(client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: true, score: 50 }, now: OPEN_NOW,
    })
    client.semesterDecision.update = async () => {
      throw new Error('db write failed')
    }
    await expect(
      markSemesterDecided(client, { enrollmentId: 'enr-1', semester: 1, periodEnded: false, now: OPEN_NOW }),
    ).rejects.toThrow('db write failed')
  })
})

describe('سباق النضج ضد السحب — طبقة التحديث المشروط نفسها', () => {
  test('سحب يهبط بين قراءة النية وكتابة الرفع: الرفع لا يحدث', async () => {
    const raced = makeClient({
      raceOnce: (existing: any, decisions: Map<string, any>, k: string) => {
        decisions.set(k, { ...existing, status: 'WITHDRAWN', withdrawnAt: new Date() })
      },
    } as any)
    await recordSemesterIntent(raced.client, {
      enrollmentId: 'enr-1', userId: 'user-1', semester: 1,
      intent: 'EARLY_FINISH', maturity: { mature: false, score: null }, now: OPEN_NOW,
    })
    const after = await tryMatureSemesterRaise(raced.client, {
      enrollmentId: 'enr-1', semester: 1, maturity: { mature: true, score: 88 }, now: OPEN_NOW,
    })
    expect(after?.status).toBe('WITHDRAWN')
    const stored = await getSemesterDecision(raced.client, 'enr-1', 1)
    expect(stored?.status).toBe('WITHDRAWN')
    expect(stored?.scoreAtRaise).toBeNull()
  })
})
