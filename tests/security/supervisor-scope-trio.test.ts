import { describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// وحدة نطاق المشرف (تدقيق ٢٠٢٦-١٠-٣٠): ثلاث بوابات كانت مفتوحة لأي مشرف على
// أي طالب — (١) تتبع طلب الالتحاق بالرقم المرجعي يسلّم الرد الكامل وفيه رمز
// رفع الوثائق البديلة، (٢) بدء الدفع عن فواتير طلاب غير معيّنين مع ختم
// الفاتورة باسم المشرف، (٣) رفع إثباتات دفع لأي طالب. القاعدة: المشرف يعمل
// فقط على طلابه المعيّنين (admissionApplication.supervisorId)، والأدمن
// والطالب صاحب الشأن لا يتغير عليهم شيء.
// ---------------------------------------------------------------------------

const ASSIGNED_SUP = { id: 'sup-assigned', role: 'SUPERVISOR', name: 'المشرف المعين', email: 'assigned@example.com' }
const OTHER_SUP = { id: 'sup-other', role: 'SUPERVISOR', name: 'مشرف غريب', email: 'other@example.com' }
const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'الأدمن', email: 'admin@example.com' }
const STUDENT = { id: 'student-1', role: 'STUDENT', name: 'محمد', email: 'student@example.com', emailVerifiedAt: new Date() }
const STRANGER_STUDENT = { id: 'student-2', role: 'STUDENT', name: 'غريب', email: 'stranger@example.com', emailVerifiedAt: new Date() }

const state: any = {
  currentUser: null,
  paymentUpdates: [] as any[],
}

const REPLACEMENT_NOTES = [
  'ملاحظات داخلية',
  '---AACT_DOCUMENT_REPLACEMENT_REQUEST---',
  JSON.stringify({ note: 'صورة الهوية غير واضحة', previousStatus: 'UNDER_REVIEW', requestedAt: '2026-10-01T00:00:00.000Z', docType: 'ID_CARD' }),
  '---END_AACT_DOCUMENT_REPLACEMENT_REQUEST---',
].join('\n')

const appFixture: any = {
  id: 'app-1',
  reference: 'AACT-2026-9999',
  email: 'student@example.com',
  phone: '+970599000000',
  fullName: 'محمد الطالب',
  status: 'DOCUMENTS_NEED_REPLACEMENT',
  notes: REPLACEMENT_NOTES,
  supervisorId: 'sup-assigned',
  userId: 'student-1',
  program: 'الموارد البشرية',
  programRef: { slug: 'hr-diploma', category: 'DIPLOMA', titleAr: 'دبلوم الموارد البشرية', admissionRules: null },
  supervisor: { name: 'المشرف المعين' },
  files: [],
  payments: [],
  theses: [],
  deliverables: [],
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
}

const paymentFixture: any = {
  id: 'pay-1',
  invoiceNo: 'INV-1001',
  status: 'PENDING',
  method: 'DIRECT_PAYMENT',
  provider: null,
  description: 'رسوم دراسية',
  amount: 100,
  amountCents: 10000,
  userId: 'student-1',
  admissionId: 'app-1',
  admission: { userId: 'student-1', email: 'student@example.com' },
  payerEmail: null,
  purpose: 'TUITION',
}

mock.module('@/lib/db', () => ({
  db: {
    admissionApplication: {
      findUnique: async ({ where }: any) => (where?.reference === appFixture.reference ? appFixture : null),
      findFirst: async ({ where }: any) => {
        // استعلام isAssignedStudent الحقيقي: طلب معيّن عليه هذا المشرف لهذا الطالب
        if (where?.supervisorId && where?.userId) {
          return appFixture.supervisorId === where.supervisorId && appFixture.userId === where.userId
            ? { id: appFixture.id }
            : null
        }
        return null
      },
      update: async () => ({}),
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    payment: {
      findUnique: async ({ where }: any) => (where?.invoiceNo === paymentFixture.invoiceNo ? paymentFixture : null),
      findFirst: async ({ where }: any) => {
        if (where?.id) return paymentFixture.id === where.id ? paymentFixture : null
        if (Array.isArray(where?.AND)) {
          for (const clause of where.AND) {
            if (clause?.id && clause.id !== paymentFixture.id) return null
            if (clause?.userId && clause.userId !== paymentFixture.userId) return null
            if (Array.isArray(clause?.OR)) {
              const matched = clause.OR.some((branch: any) => {
                if (branch?.admission?.is) {
                  const want = branch.admission.is
                  return paymentFixture.admission?.userId === want.userId && paymentFixture.admission?.email === want.email
                }
                if (branch?.userId) {
                  return paymentFixture.userId === branch.userId && (paymentFixture.payerEmail || null) === (branch.payerEmail || null)
                }
                return false
              })
              if (!matched) return null
            }
          }
          return paymentFixture
        }
        return null
      },
      update: async (args: any) => {
        state.paymentUpdates.push(args)
        return { ...paymentFixture, ...args.data }
      },
      updateMany: async () => ({ count: 0 }),
    },
    paymentProof: {
      findUnique: async () => null,
      create: async ({ data }: any) => ({ id: 'proof-1', ...data }),
    },
    user: { findMany: async () => [], findUnique: async () => state.currentUser },
    $transaction: async (ops: any[]) => Promise.all(ops),
  },
}))

mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => state.currentUser,
  requireUser: async () => {
    if (!state.currentUser) throw new Error('UNAUTHORIZED')
    return state.currentUser
  },
}))

mock.module('@/lib/notify', () => ({ notify: async () => {}, audit: async () => {} }))

mock.module('@/lib/payments', () => ({
  getGatewayConfig: async () => ({}),
  paymentMethodStatus: () => ({ enabled: false, reason: 'طريقة غير متاحة في الاختبار' }),
  createProviderCheckout: async () => ({ ok: false, error: 'غير متاح' }),
}))

mock.module('@/lib/storage', () => ({
  storeFileBuffer: async () => ({ key: 'payment-proofs/proof.png', url: '/api/files/payment-proofs/proof.png' }),
  storeFileBufferAtKey: async () => ({ key: 'payment-proofs/proof.png', url: '/api/files/payment-proofs/proof.png' }),
  storageErrorMessage: (e: any) => String(e?.message || e),
  deleteStoredFile: async () => true,
  readStoredFile: async () => null,
  getFileBufferFromStorageOrBase64: async () => null,
  getFileStreamFromStorageOrBase64: async () => null,
  getPublicStorageUrlForKey: () => null,
  createSignedStorageUrlForKey: () => null,
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
  signLocalStorageDownloadPath: (key: string) => `/api/files/${key}`,
  verifyLocalStorageDownloadSignature: () => false,
  configuredAllowedStorageHosts: () => [],
  isPrivateIp: () => false,
  externalStoredFile: (url: string, fileName: string) => ({ key: url, url, fileName }),
}))

// student-record-ownership يبقى الحقيقي: studentOwnsAdmission و
// studentPaymentOwnershipWhere جزء من منطق الملكية قيد الاختبار نفسه.

const admissionsRoute = await import('@/app/api/admissions/route')
const checkoutRoute = await import('@/app/api/payments/checkout/route')
const proofsRoute = await import('@/app/api/payments/proofs/route')

function trackReq(params: string) {
  return new NextRequest(`http://localhost/api/admissions?${params}`)
}

async function track(params: string) {
  const res = await admissionsRoute.GET(trackReq(params))
  return { status: res.status, body: await res.json() }
}

describe('بوابة التتبع: رمز رفع الوثائق البديلة لا يصل إلا لصاحبه', () => {
  test('مشرف غير معيّن على الطلب: لا تحقق كامل ولا رمز رفع', async () => {
    state.currentUser = OTHER_SUP
    const { body } = await track('ref=AACT-2026-9999')
    expect(body.verified).toBe(false)
    expect(body.application?.replacementUploadToken ?? null).toBeNull()
  })

  test('المشرف المعيّن على الطلب: تحقق كامل ورمز الرفع موجود', async () => {
    state.currentUser = ASSIGNED_SUP
    const { body } = await track('ref=AACT-2026-9999')
    expect(body.verified).toBe(true)
    expect(typeof body.application?.replacementUploadToken).toBe('string')
    expect(body.application.replacementUploadToken.length).toBeGreaterThan(10)
  })

  test('الأدمن: تحقق كامل كالعادة', async () => {
    state.currentUser = ADMIN
    const { body } = await track('ref=AACT-2026-9999')
    expect(body.verified).toBe(true)
    expect(typeof body.application?.replacementUploadToken).toBe('string')
  })

  test('زائر بلا حساب يثبت بالإيميل وآخر ٤ أرقام: التدفق العام سليم', async () => {
    state.currentUser = null
    const { body } = await track('ref=AACT-2026-9999&email=student@example.com&phoneLast4=0000')
    expect(body.verified).toBe(true)
    expect(typeof body.application?.replacementUploadToken).toBe('string')
  })
})

async function checkout(user: any, body: any, payment: any = paymentFixture) {
  state.currentUser = user
  state.paymentUpdates = []
  const original = { ...paymentFixture }
  Object.assign(paymentFixture, payment)
  try {
    const req = new NextRequest('http://localhost/api/payments/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const res = await checkoutRoute.POST(req)
    return { status: res.status, body: await res.json() }
  } finally {
    Object.assign(paymentFixture, original)
  }
}

describe('بوابة بدء الدفع: المشرف يعمل على فواتير طلابه فقط ولا تُختم باسمه', () => {
  test('مشرف غير معيّن: ٤٠٣ قبل أي خطوة دفع', async () => {
    const { status } = await checkout(OTHER_SUP, { invoiceNo: 'INV-1001', method: 'CARD' })
    expect(status).toBe(403)
    expect(state.paymentUpdates).toHaveLength(0)
  })

  test('مشرف معيّن: يجتاز بوابة الملكية (يُرفض لاحقاً لتعذر الطريقة بالاختبار)', async () => {
    const { status } = await checkout(ASSIGNED_SUP, { invoiceNo: 'INV-1001', method: 'CARD' })
    expect(status).toBe(400)
  })

  test('مشرف معيّن + دفع يدوي: تُسجل الفاتورة باسم الطالب لا المشرف', async () => {
    const { status, body } = await checkout(ASSIGNED_SUP, { invoiceNo: 'INV-1001', method: 'DIRECT_PAYMENT' })
    expect(status).toBe(200)
    expect(body.mode).toBe('MANUAL')
    const update = state.paymentUpdates.find((u: any) => u?.data?.userId)
    expect(update?.data?.userId).toBe('student-1')
  })

  test('فاتورة بلا مالك طالب: المشرف لا يستطيع تبنيها', async () => {
    const { status } = await checkout(ASSIGNED_SUP, { invoiceNo: 'INV-1001', method: 'CARD' }, { userId: null, admissionId: null, admission: null })
    expect(status).toBe(403)
  })

  test('الأدمن: يعمل على أي فاتورة كالعادة', async () => {
    const { status } = await checkout(ADMIN, { invoiceNo: 'INV-1001', method: 'CARD' })
    expect(status).toBe(400)
  })
})

function pngForm(paymentId: string) {
  const form = new FormData()
  form.set('paymentId', paymentId)
  form.set('amount', '100')
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])], 'proof.png', { type: 'image/png' })
  form.set('file', png)
  return new NextRequest('http://localhost/api/payments/proofs', { method: 'POST', body: form })
}

describe('بوابة رفع إثباتات الدفع: المشرف لطلابه فقط', () => {
  test('مشرف غير معيّن: ٤٠٤ كأن الفاتورة غير موجودة', async () => {
    state.currentUser = OTHER_SUP
    const res = await proofsRoute.POST(pngForm('pay-1'))
    expect(res.status).toBe(404)
  })

  test('مشرف معيّن: يرفع الإثبات بنجاح', async () => {
    state.currentUser = ASSIGNED_SUP
    const res = await proofsRoute.POST(pngForm('pay-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  test('الطالب صاحب الفاتورة: يرفع كالعادة', async () => {
    state.currentUser = STUDENT
    const res = await proofsRoute.POST(pngForm('pay-1'))
    expect(res.status).toBe(200)
  })

  test('طالب غريب: الفاتورة لا تظهر له أصلاً', async () => {
    state.currentUser = STRANGER_STUDENT
    const res = await proofsRoute.POST(pngForm('pay-1'))
    expect(res.status).toBe(404)
  })
})
