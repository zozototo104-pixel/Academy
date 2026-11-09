// حارس دليل دراسة فحص الجاهزية (بوابة #703، 2026-11-09):
// المسار كان يستخدم upsert بمفتاح programId_semester غير الموجود كقيد
// فريد في المخطط (فهرس فقط)، فكان يرمي PrismaClientValidationError
// ويُرجع 500 دائماً. الإصلاح: بحث-أو-إنشاء داخل قفل استشاري، مقصور على
// الدليل العام (unitId: null). هذا الاختبار يثبت سلوكياً — بقاعدة وهمية
// تحاكي تسلسل القفل — أن: أول تشغيل ينشئ دليلاً عاماً واحداً، وإعادة
// التشغيل تحدّثه ولا تنشئ نسخة، ونداءان متزامنان لا ينشئان نسختين،
// وأدلة الوحدات لا تُلمس. ويثبت نصياً أن المفتاح الوهمي لا يعود.
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

type Guide = Record<string, any>
const guides: Guide[] = []
let seq = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// قفل وهمي يحاكي قفل Postgres الاستشاري: يُقتنى من $executeRaw داخل
// المعاملة ويُحرَّر عند انتهائها، فيُسلسِل المعاملات المتنافسة.
let lockChain: Promise<void> = Promise.resolve()
let releaseCurrent: (() => void) | null = null
async function acquireLock() {
  let release!: () => void
  const next = new Promise<void>((res) => {
    release = res
  })
  const prev = lockChain
  lockChain = prev.then(() => next)
  await prev
  releaseCurrent = release
}

const fakeTx = {
  $executeRaw: async () => {
    await acquireLock()
    return 0
  },
  programStudyGuide: {
    findFirst: async ({ where }: any) => {
      await sleep(5) // نافذة سباق حقيقية: بلا قفل يرى نداءان «لا شيء» معاً
      const rows = guides
        .filter(
          (g) =>
            g.programId === where.programId &&
            g.semester === where.semester &&
            (where.unitId === null ? g.unitId == null : g.unitId === where.unitId),
        )
        .sort((a, b) => +a.createdAt - +b.createdAt)
      return rows[0] || null
    },
    create: async ({ data }: any) => {
      await sleep(5) // زمن رحلة الإدراج: بلا قفل يرى النداء الثاني الفراغ أيضاً
      const row: Guide = { id: `guide-${++seq}`, createdAt: new Date(Date.now() + seq), ...data }
      guides.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = guides.find((g) => g.id === where.id)
      if (!row) throw new Error('guide not found')
      Object.assign(row, data)
      return row
    },
  },
}

const fakeDb = {
  $transaction: async (cb: any) => {
    try {
      return await cb(fakeTx)
    } finally {
      releaseCurrent?.()
      releaseCurrent = null
    }
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))

const { ensureLaunchQualityStudyGuide } = await import('@/lib/launch-quality-study-guide')

const PROGRAM_ID = 'program-diagnostic-1'
const generalGuides = () => guides.filter((g) => g.programId === PROGRAM_ID && g.unitId == null)

function reset() {
  guides.length = 0
  seq = 0
}

describe('دليل دراسة فحص الجاهزية: بحث-أو-إنشاء آمن عند إعادة التشغيل', () => {
  test('أول تشغيل ينشئ دليلاً عاماً واحداً بالحقول التشخيصية', async () => {
    reset()
    const guide = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(generalGuides().length).toBe(1)
    expect(guide.unitId ?? null).toBeNull()
    expect(guide.semester).toBe(1)
    expect(guide.status).toBe('PUBLISHED')
    expect(guide.title).toContain('دليل دراسة الفصل الأول')
    expect(guide.generatedBy).toBe('ADMIN')
  })

  test('إعادة التشغيل تحدّث الدليل نفسه ولا تنشئ نسخة', async () => {
    reset()
    const first = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    const second = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    const third = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(generalGuides().length).toBe(1)
    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
  })

  test('نداءان متزامنان لا ينشئان دليلين عامّين', async () => {
    reset()
    const [a, b] = await Promise.all([
      ensureLaunchQualityStudyGuide(PROGRAM_ID),
      ensureLaunchQualityStudyGuide(PROGRAM_ID),
    ])
    expect(generalGuides().length).toBe(1)
    expect(a.id).toBe(b.id)
  })

  test('دليل وحدة لنفس البرنامج والفصل لا يُلمس ولا يحل محل الدليل العام', async () => {
    reset()
    guides.push({
      id: 'unit-guide-1',
      programId: PROGRAM_ID,
      semester: 1,
      unitId: 'unit-9',
      title: 'دليل وحدة أصلي',
      status: 'PUBLISHED',
      createdAt: new Date(),
    })
    const guide = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(guide.id).not.toBe('unit-guide-1')
    expect(generalGuides().length).toBe(1)
    expect(guides.find((g) => g.id === 'unit-guide-1')?.title).toBe('دليل وحدة أصلي')
  })

  test('المسار لا يستخدم مفتاح programId_semester الوهمي والمخطط بلا قيد فريد جديد', () => {
    const routeSource = readFileSync(new URL('../../src/app/api/admin/launch-quality/route.ts', import.meta.url), 'utf8')
    expect(routeSource).not.toContain('programId_semester')
    expect(routeSource).toContain('ensureLaunchQualityStudyGuide')
    const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
    const start = schema.indexOf('model ProgramStudyGuide ')
    const block = schema.slice(start, schema.indexOf('}', start))
    expect(block).toContain('@@index([programId, semester])')
    expect(block).not.toContain('@@unique([programId, semester])')
  })
})
