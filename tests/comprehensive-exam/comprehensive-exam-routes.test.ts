// Comprehensive exam — route handlers against an in-memory fake DB.
// Real route code, real validation; only the DB/auth/audit are faked.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'

let exams: any[] = []
let questions: any[] = []
let bankItems: any[] = []
let qSeq = 0
let startedAttempts = 0
let pendingInvitations = 0

const program = {
  id: 'program-1',
  titleAr: 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية',
  titleEn: 'Professional Certificates and Professional Experience Equivalency Program',
  slug: 'training-certificates-equivalency',
  category: 'SERVICE',
  active: true,
}

const specializationProgram = {
  id: 'spec-1',
  titleAr: 'الماجستير المهني في إدارة الأعمال',
  titleEn: 'Professional Master in Business Administration',
  category: 'MASTERS',
  active: true,
}

const otherServiceProgram = {
  id: 'service-2',
  titleAr: 'خدمة مهنية أخرى',
  titleEn: 'Another Service',
  slug: 'other-service',
  category: 'SERVICE',
  active: true,
}

const programs = [program, specializationProgram, otherServiceProgram]

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  program: {
    findUnique: async ({ where }: any) => {
      const p = programs.find((x) => x.id === where?.id)
      return p ? { ...p } : null
    },
  },
  comprehensiveExam: {
    findMany: async ({ where }: any = {}) =>
      exams
        .filter((e) => !where?.programId || e.programId === where.programId)
        .map((e) => ({ ...e, program: { ...program }, specializationProgram: { ...specializationProgram }, _count: { questions: questions.filter((q) => q.examId === e.id).length } })),
    findFirst: async ({ where }: any = {}) =>
      exams.find(
        (e) =>
          (!where?.programId || e.programId === where.programId) &&
          (!where?.specializationProgramId || e.specializationProgramId === where.specializationProgramId) &&
          (!where?.status?.in || where.status.in.includes(e.status)) &&
          (!where?.id?.not || e.id !== where.id.not),
      ) || null,
    findUnique: async ({ where }: any) => {
      const e = exams.find((x) => x.id === where?.id)
      if (!e) return null
      return { ...e, program: { ...program }, specializationProgram: { ...specializationProgram }, questions: questions.filter((q) => q.examId === e.id).sort((a, b) => a.order - b.order) }
    },
    create: async ({ data }: any) => {
      const e = { id: `exam-${exams.length + 1}`, ...data, publishedAt: null, createdAt: new Date(), updatedAt: new Date() }
      exams.push(e)
      return e
    },
    update: async ({ where, data }: any) => {
      const e = exams.find((x) => x.id === where?.id && (!where?.status || x.status === where.status))
      if (!e) throw new Error('NOT_FOUND')
      Object.assign(e, data, { updatedAt: new Date() })
      return e
    },
    updateMany: async ({ where, data }: any) => {
      const e = exams.find((x) => x.id === where?.id && (!where?.status || x.status === where.status))
      if (!e) return { count: 0 }
      Object.assign(e, data, { updatedAt: new Date() })
      return { count: 1 }
    },
  },
  comprehensiveExamAttempt: { count: async () => startedAttempts },
  comprehensiveExamInvitation: { count: async () => pendingInvitations },
  comprehensiveExamQuestion: {
    groupBy: async ({ where }: any = {}) => {
      const counts = new Map<string, number>()
      for (const q of questions.filter((x) => !where?.examId || x.examId === where.examId)) {
        counts.set(q.status, (counts.get(q.status) || 0) + 1)
      }
      return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }))
    },
    count: async ({ where }: any = {}) =>
      questions.filter((q) => q.examId === where?.examId && (!where?.status || q.status === where.status)).length,
    findMany: async ({ where }: any = {}) =>
      questions
        .filter((q) => q.examId === where?.examId && (!where?.status || q.status === where.status))
        .sort((a, b) => a.order - b.order),
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = questions.filter((q) => !where?.examId || q.examId === where.examId)
      if (orderBy?.order === 'desc') rows.sort((a, b) => b.order - a.order)
      return rows[0] || null
    },
    findUnique: async ({ where }: any) => questions.find((q) => q.id === where?.id) || null,
    create: async ({ data }: any) => {
      const q = { id: `q-${++qSeq}`, ...data, createdAt: new Date(), updatedAt: new Date() }
      questions.push(q)
      return q
    },
    createMany: async ({ data }: any) => {
      for (const row of data) {
        questions.push({ id: `q-${++qSeq}`, ...row, createdAt: new Date(), updatedAt: new Date() })
      }
      return { count: data.length }
    },
    update: async ({ where, data }: any) => {
      const q = questions.find((x) => x.id === where?.id)
      if (!q) throw new Error('NOT_FOUND')
      Object.assign(q, data, { updatedAt: new Date() })
      return q
    },
    delete: async ({ where }: any) => {
      const i = questions.findIndex((x) => x.id === where?.id)
      if (i < 0) throw new Error('NOT_FOUND')
      questions.splice(i, 1)
      return { id: where.id }
    },
  },
  questionBankItem: {
    findMany: async ({ where }: any = {}) =>
      bankItems.filter(
        (b) =>
          (!where?.id?.in || where.id.in.includes(b.id)) &&
          (!where?.programId || b.programId === where.programId) &&
          (!where?.status || b.status === where.status),
      ),
    updateMany: async () => ({ count: 1 }),
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => null }))
mock.module('@/lib/document-extract', () => ({
  extractDocumentText: async () => ({
    text: 'MCQ\tأي مما يلي يُعد من الأصول المتداولة؟\tالنقدية\tالمباني\tالشهرة\t\t0',
    readable: true,
    reader: 'TEXT',
    note: 'ok',
  }),
}))

const examsRoute = await import('../../src/app/api/admin/comprehensive-exams/route')
const detailRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/route')
const publishRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/publish/route')
const questionsRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/route')
const fromBankRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/from-bank/route')
const importRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/import/route')
const questionRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/[questionId]/route')

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

function ctx(id: string, extra: Record<string, string> = {}): any {
  return { params: Promise.resolve({ id, ...extra }) }
}

function seedApproved(examId: string, n: number) {
  for (let i = 0; i < n; i++) {
    questions.push({
      id: `seed-${i}`,
      examId,
      order: i + 1,
      type: 'MCQ',
      text: `سؤال معتمد رقم ${i + 1} عن الأصول المتداولة في القوائم المالية؟`,
      options: JSON.stringify(['النقدية', 'المباني', 'الشهرة', 'براءات الاختراع']),
      correctAnswer: '0',
      source: 'MANUAL',
      sourceEvidence: null,
      status: 'APPROVED',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
}

beforeEach(() => {
  exams = []
  questions = []
  qSeq = 0
  startedAttempts = 0
  pendingInvitations = 0
  bankItems = [
    {
      id: 'bank-1', programId: 'spec-1', type: 'MCQ', status: 'APPROVED',
      text: 'أي مما يلي يُعد من الأصول المتداولة؟',
      options: JSON.stringify(['النقدية', 'المباني', 'الشهرة']),
      correctAnswer: '0', sourceEvidence: 'تعريف الأصول المتداولة.', bookId: 'book-1',
    },
    {
      id: 'bank-2', programId: 'spec-1', type: 'ESSAY', status: 'APPROVED',
      text: 'اشرح الأصول المتداولة بالتفصيل.',
      options: null, correctAnswer: null, sourceEvidence: null, bookId: 'book-1',
    },
  ]
})

async function createExam(over: Record<string, unknown> = {}) {
  const res = await examsRoute.POST(req('/api/admin/comprehensive-exams', 'POST', { programId: 'program-1', specializationProgramId: 'spec-1', passScore: 60, durationMin: 120, ...over }))
  const body = await res.json()
  expect(res.status).toBe(201)
  return body.examId as string
}

describe('POST /api/admin/comprehensive-exams', () => {
  test('creates a DRAFT exam snapshotting the program level', async () => {
    const examId = await createExam()
    expect(exams[0].level).toBe('MASTERS')
    expect(exams[0].status).toBe('DRAFT')
    expect(exams[0].passScore).toBe(60)
    expect(exams[0].durationMin).toBe(120)
    expect(examId).toBe(exams[0].id)
  })

  test('refuses a second live exam for the same program', async () => {
    await createExam()
    const res = await examsRoute.POST(req('/api/admin/comprehensive-exams', 'POST', { programId: 'program-1', specializationProgramId: 'spec-1' }))
    expect(res.status).toBe(409)
  })

  test('refuses an unknown program', async () => {
    const res = await examsRoute.POST(req('/api/admin/comprehensive-exams', 'POST', { programId: 'no-such', specializationProgramId: 'spec-1' }))
    expect(res.status).toBe(404)
  })

  test('refuses a study program as the exam program — only the equivalency service program qualifies', async () => {
    const res = await examsRoute.POST(req('/api/admin/comprehensive-exams', 'POST', { programId: 'spec-1', specializationProgramId: 'program-1' }))
    expect(res.status).toBe(409)
  })

  test('refuses a SERVICE-category program as the specialization', async () => {
    const res = await examsRoute.POST(req('/api/admin/comprehensive-exams', 'POST', { programId: 'program-1', specializationProgramId: 'service-2' }))
    expect(res.status).toBe(400)
  })
})

describe('POST .../questions (manual)', () => {
  test('adds a TF question as PENDING_REVIEW', async () => {
    const examId = await createExam()
    const res = await questionsRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/questions`, 'POST', {
        type: 'TF',
        text: 'المباني أصل متداول في القوائم المالية.',
        correctAnswer: 'خطأ',
      }),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(questions[0].type).toBe('TF')
    expect(questions[0].status).toBe('PENDING_REVIEW')
    expect(questions[0].options).toBe(JSON.stringify(['صح', 'خطأ']))
    expect(body.questionId).toBe(questions[0].id)
  })

  test('refuses an essay question with 400', async () => {
    const examId = await createExam()
    const res = await questionsRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/questions`, 'POST', {
        type: 'ESSAY',
        text: 'اشرح الأصول المتداولة بالتفصيل.',
      }),
      ctx(examId),
    )
    expect(res.status).toBe(400)
    expect(questions).toHaveLength(0)
  })
})

describe('POST .../publish (the 100-question gate)', () => {
  test('99 approved is refused with needed = 1', async () => {
    const examId = await createExam()
    seedApproved(examId, 99)
    const res = await publishRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/publish`, 'POST', { action: 'publish' }),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.approved).toBe(99)
    expect(body.needed).toBe(1)
    expect(exams[0].status).toBe('DRAFT')
  })

  test('100 approved publishes and sets totalPoints = 200', async () => {
    const examId = await createExam()
    seedApproved(examId, 100)
    const res = await publishRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/publish`, 'POST', { action: 'publish' }),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('READY')
    expect(exams[0].status).toBe('READY')
    expect(exams[0].totalPoints).toBe(200)
    expect(exams[0].publishedAt).not.toBeNull()
  })

  test('101 approved is refused — the system never drops a question for the admin', async () => {
    const examId = await createExam()
    seedApproved(examId, 101)
    const res = await publishRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/publish`, 'POST', { action: 'publish' }),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.excess).toBe(1)
    expect(exams[0].status).toBe('DRAFT')
  })
})

describe('PATCH .../questions/[questionId] (review)', () => {
  test('approving re-validates and stamps the approver', async () => {
    const examId = await createExam()
    const add = await questionsRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/questions`, 'POST', {
        type: 'MCQ',
        text: 'أي مما يلي يُعد من الأصول المتداولة؟',
        options: ['النقدية', 'المباني', 'الشهرة'],
        correctAnswer: '0',
      }),
      ctx(examId),
    )
    const { questionId } = await add.json()
    const res = await questionRoute.PATCH(
      req(`/api/admin/comprehensive-exams/${examId}/questions/${questionId}`, 'PATCH', { status: 'APPROVED' }),
      ctx(examId, { questionId }),
    )
    expect(res.status).toBe(200)
    expect(questions[0].status).toBe('APPROVED')
    expect(questions[0].approvedById).toBe('admin-1')
  })

  test('rejecting without a reason is refused', async () => {
    const examId = await createExam()
    const add = await questionsRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/questions`, 'POST', {
        type: 'MCQ',
        text: 'أي مما يلي يُعد من الأصول المتداولة؟',
        options: ['النقدية', 'المباني', 'الشهرة'],
        correctAnswer: '0',
      }),
      ctx(examId),
    )
    const { questionId } = await add.json()
    const res = await questionRoute.PATCH(
      req(`/api/admin/comprehensive-exams/${examId}/questions/${questionId}`, 'PATCH', { status: 'REJECTED' }),
      ctx(examId, { questionId }),
    )
    expect(res.status).toBe(400)
    expect(questions[0].status).toBe('PENDING_REVIEW')
  })

  test('editing an approved question sends it back to review', async () => {
    const examId = await createExam()
    seedApproved(examId, 1)
    const qid = questions[0].id
    const res = await questionRoute.PATCH(
      req(`/api/admin/comprehensive-exams/${examId}/questions/${qid}`, 'PATCH', { text: 'أي مما يلي يُعد من الأصول المتداولة في القوائم؟' }),
      ctx(examId, { questionId: qid }),
    )
    expect(res.status).toBe(200)
    expect(questions[0].status).toBe('PENDING_REVIEW')
  })

  test('deleting removes the draft question', async () => {
    const examId = await createExam()
    seedApproved(examId, 1)
    const qid = questions[0].id
    const res = await questionRoute.DELETE(
      new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}/questions/${qid}`, 'http://localhost'), { method: 'DELETE' }),
      ctx(examId, { questionId: qid }),
    )
    expect(res.status).toBe(200)
    expect(questions).toHaveLength(0)
  })
})

describe('POST .../questions/from-bank', () => {
  test('imports only APPROVED MCQ/TF bank items; essay is refused, not converted', async () => {
    const examId = await createExam()
    const res = await fromBankRoute.POST(
      req(`/api/admin/comprehensive-exams/${examId}/questions/from-bank`, 'POST', { bankItemIds: ['bank-1', 'bank-2'] }),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.imported).toBe(1)
    expect(body.refused).toEqual(['bank-2'])
    expect(questions).toHaveLength(1)
    expect(questions[0].status).toBe('APPROVED')
    expect(questions[0].bankItemId).toBe('bank-1')
    expect(questions[0].source).toBe('BANK')
  })
})

describe('POST .../questions/import (Excel)', () => {
  test('dryRun previews without saving; real import saves as PENDING_REVIEW', async () => {
    const examId = await createExam()
    const ws = XLSX.utils.aoa_to_sheet([
      ['السؤال', 'النوع', 'الخيار 1', 'الخيار 2', 'الخيار 3', 'الخيار 4', 'الإجابة الصحيحة', 'الدليل'],
      ['أي مما يلي يُعد من الأصول المتداولة؟', 'اختيار متعدد', 'النقدية', 'المباني', 'الشهرة', '', '1', ''],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'أسئلة')
    const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const file = new File([buffer], 'questions.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const fdDry = new FormData()
    fdDry.append('file', file)
    const dry = await importRoute.POST(
      new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}/questions/import?dryRun=true`, 'http://localhost'), { method: 'POST', body: fdDry }),
      ctx(examId),
    )
    const dryBody = await dry.json()
    expect(dry.status).toBe(200)
    expect(dryBody.dryRun).toBe(true)
    expect(dryBody.valid).toBe(1)
    expect(questions).toHaveLength(0)

    const fd = new FormData()
    fd.append('file', file)
    const real = await importRoute.POST(
      new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}/questions/import`, 'http://localhost'), { method: 'POST', body: fd }),
      ctx(examId),
    )
    const realBody = await real.json()
    expect(real.status).toBe(200)
    expect(realBody.imported).toBe(1)
    expect(questions).toHaveLength(1)
    expect(questions[0].status).toBe('PENDING_REVIEW')
    expect(questions[0].source).toBe('EXCEL_IMPORT')
  })
})

describe('GET .../[id] (detail)', () => {
  test('returns counts and questions', async () => {
    const examId = await createExam()
    seedApproved(examId, 2)
    const res = await detailRoute.GET(
      new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}`, 'http://localhost')),
      ctx(examId),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.counts).toEqual({ total: 2, approved: 2, pending: 0, rejected: 0 })
    expect(body.questions).toHaveLength(2)
    expect(body.exam.specialtyLabel).toBe('إدارة الأعمال')
  })
})
