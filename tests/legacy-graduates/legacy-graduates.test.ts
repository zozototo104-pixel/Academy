/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.test'

type AnyRecord = Record<string, any>

const users = new Map<string, AnyRecord>()
const programs = new Map<string, AnyRecord>()
const enrollments = new Map<string, AnyRecord>()
const certificates = new Map<string, AnyRecord>()
const audits: AnyRecord[] = []
const storedFiles = new Map<string, { buffer: Buffer; mimeType: string }>()
let userSeq = 0
let enrollmentSeq = 0
let certificateSeq = 0
let serialSeq = 0
let storageSeq = 0
let currentAdmin: AnyRecord | null = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
let currentUser: AnyRecord | null = { id: 'admin-1', name: 'Admin', role: 'ADMIN', email: 'admin@example.com' }
let emailStatus: 'SENT' | 'SKIPPED' | 'FAILED' = 'SENT'

function clone<T extends AnyRecord>(item: T | null | undefined): T | null {
  return item ? ({ ...item } as T) : null
}

function enrollmentKey(userId: string, programId: string) {
  return `${userId}:${programId}`
}

function includesInsensitive(value: unknown, search: string) {
  return String(value || '').toLowerCase().includes(search.toLowerCase())
}

function certificateMatches(cert: AnyRecord, where: AnyRecord = {}): boolean {
  if (where.OR) return where.OR.some((clause: AnyRecord) => certificateMatches(cert, clause))
  if (where.id && cert.id !== where.id) return false
  if (where.serial && cert.serial !== where.serial) return false
  if (where.qrToken && cert.qrToken !== where.qrToken) return false
  if (where.legacySerial && typeof where.legacySerial === 'string' && cert.legacySerial !== where.legacySerial) return false
  if (where.legacySerial?.in && !where.legacySerial.in.includes(cert.legacySerial)) return false
  if (where.enrollmentId && cert.enrollmentId !== where.enrollmentId) return false
  if (where.type && cert.type !== where.type) return false
  if (typeof where.legacy === 'boolean' && cert.legacy !== where.legacy) return false
  if (where.userId && typeof where.userId === 'string' && cert.userId !== where.userId) return false
  if (where.userId?.in && !where.userId.in.includes(cert.userId)) return false
  for (const field of ['holderName', 'program', 'grade', 'country', 'serial', 'legacySerial']) {
    if (where[field]?.contains && !includesInsensitive(cert[field], where[field].contains)) return false
  }
  return true
}

const db: any = {
  $queryRaw: async () => [{ value: BigInt(++serialSeq) }],
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  program: {
    findUnique: async ({ where }: { where: AnyRecord }) => clone(programs.get(where.id)),
    findMany: async () => [...programs.values()].map((program) => clone(program)),
  },
  user: {
    findUnique: async ({ where }: { where: AnyRecord }) => {
      if (where.id) return clone(users.get(where.id))
      return clone([...users.values()].find((user) => user.email === where.email))
    },
    findMany: async ({ where }: { where: AnyRecord }) => [...users.values()].filter((user) => {
      const search = where?.OR?.[0]?.email?.contains || where?.OR?.[1]?.name?.contains || where?.OR?.[2]?.phone?.contains || ''
      return !search || includesInsensitive(user.email, search) || includesInsensitive(user.name, search) || includesInsensitive(user.phone, search)
    }).map((user) => ({ id: user.id })),
    create: async ({ data }: { data: AnyRecord }) => {
      const user = { id: `user-${++userSeq}`, status: 'ACTIVE', ...data }
      users.set(user.id, user)
      return clone(user)
    },
    update: async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
      const user = users.get(where.id)
      if (!user) throw new Error('USER_NOT_FOUND')
      Object.assign(user, data)
      return clone(user)
    },
  },
  enrollment: {
    upsert: async ({ where, create, update }: { where: AnyRecord; create: AnyRecord; update: AnyRecord }) => {
      const key = enrollmentKey(where.userId_programId.userId, where.userId_programId.programId)
      const existing = enrollments.get(key)
      if (existing) {
        Object.assign(existing, update)
        return clone(existing)
      }
      const enrollment = { id: `enrollment-${++enrollmentSeq}`, ...create }
      enrollments.set(key, enrollment)
      return clone(enrollment)
    },
    update: async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
      const entry = [...enrollments.values()].find((item) => item.id === where.id)
      if (!entry) throw new Error('ENROLLMENT_NOT_FOUND')
      Object.assign(entry, data)
      return clone(entry)
    },
    findUnique: async ({ where }: { where: AnyRecord }) => {
      if (where.id) return clone([...enrollments.values()].find((item) => item.id === where.id))
      if (where.userId_programId) return clone(enrollments.get(enrollmentKey(where.userId_programId.userId, where.userId_programId.programId)))
      return null
    },
    findFirst: async ({ where }: { where: AnyRecord }) => clone([...enrollments.values()].find((item) => item.certificateNo === where.certificateNo && (!where.userId || item.userId === where.userId))),
  },
  certificate: {
    findFirst: async ({ where }: { where: AnyRecord }) => clone([...certificates.values()].find((cert) => certificateMatches(cert, where))),
    findUnique: async ({ where }: { where: AnyRecord }) => {
      if (where.id) return clone(certificates.get(where.id))
      if (where.legacySerial) return clone([...certificates.values()].find((cert) => cert.legacySerial === where.legacySerial))
      return null
    },
    findMany: async ({ where }: { where: AnyRecord }) => [...certificates.values()].filter((cert) => certificateMatches(cert, where)).map((cert) => clone(cert)),
    count: async ({ where }: { where: AnyRecord }) => [...certificates.values()].filter((cert) => certificateMatches(cert, where)).length,
    create: async ({ data }: { data: AnyRecord }) => {
      const cert = { id: `cert-${++certificateSeq}`, valid: true, issuedAt: new Date(), ...data }
      certificates.set(cert.id, cert)
      return clone(cert)
    },
    update: async ({ where, data }: { where: AnyRecord; data: AnyRecord }) => {
      const cert = certificates.get(where.id)
      if (!cert) throw new Error('CERT_NOT_FOUND')
      Object.assign(cert, data)
      return clone(cert)
    },
  },
  admissionApplication: { findMany: async () => [], findUnique: async () => null },
  payment: { findMany: async () => [] },
  thesisSubmission: { findFirst: async () => null, findMany: async () => [] },
  examAttempt: { findMany: async () => [] },
  programExamAttempt: { findMany: async () => [] },
  assignmentSubmission: { findMany: async () => [] },
  agentApplication: { findUnique: async () => null },
  auditLog: { create: async ({ data }: { data: AnyRecord }) => { const audit = { id: `audit-${audits.length + 1}`, ...data }; audits.push(audit); return audit } },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => {
    if (!currentAdmin) throw new Error('UNAUTHORIZED')
    return currentAdmin
  },
  getCurrentUser: async () => currentUser,
}))
mock.module('@/lib/mailer', () => ({
  emailPasswordResetDetailed: async () => emailStatus,
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: { buffer: Buffer; fileName: string; mimeType?: string | null; namespace: string }) => {
    const key = `${input.namespace}/file-${++storageSeq}-${input.fileName}`
    storedFiles.set(key, { buffer: input.buffer, mimeType: input.mimeType || 'application/octet-stream' })
    return { provider: 'local', key, url: `/uploads/${key}`, size: input.buffer.byteLength, mimeType: input.mimeType || 'application/octet-stream' }
  },
  readStoredFile: async (input: { key?: string | null; mimeType?: string | null }) => {
    const stored = input.key ? storedFiles.get(input.key) : null
    return stored ? { buffer: stored.buffer, mimeType: stored.mimeType || input.mimeType || 'application/octet-stream' } : null
  },
}))
mock.module('@/lib/rate-limit', () => ({
  enforceDatabaseApiRateLimit: async () => null,
  enforceApiRateLimit: () => null,
}))
mock.module('@/lib/pdf/official', () => ({
  pdfDate: (value: Date | string | null | undefined) => value ? new Date(value).toISOString().slice(0, 10) : '—',
  pdfSafeText: (value: unknown, fallback = '—') => String(value ?? '').trim() || fallback,
  renderOfficialPdf: async () => new Uint8Array(Buffer.from('%PDF-generated-template')),
  pdfResponse: (pdf: Uint8Array, filename: string) => {
    const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"` } })
  },
}))

const { createLegacyGraduate } = await import('../../src/lib/legacy-graduates')
const { parseLegacyGraduateWorkbook, validateLegacyGraduateImportRows } = await import('../../src/lib/legacy-graduates-import')
const { sniffLegacyCertificateMime } = await import('../../src/lib/legacy-certificate-files')
const adminLegacyRoute = await import('../../src/app/api/admin/legacy-graduates/route')
const importRoute = await import('../../src/app/api/admin/legacy-graduates/import/route')
const uploadRoute = await import('../../src/app/api/admin/legacy-graduates/[certificateId]/upload/route')
const importFilesRoute = await import('../../src/app/api/admin/legacy-graduates/import-files/route')
const resendRoute = await import('../../src/app/api/admin/legacy-graduates/[certificateId]/resend-invite/route')
const verifyRoute = await import('../../src/app/api/certificates/verify/route')
const pdfRoute = await import('../../src/app/api/pdf/certificates/[id]/route')

function resetState() {
  users.clear(); programs.clear(); enrollments.clear(); certificates.clear(); audits.splice(0); storedFiles.clear()
  userSeq = 0; enrollmentSeq = 0; certificateSeq = 0; serialSeq = 0; storageSeq = 0
  currentAdmin = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
  currentUser = { id: 'admin-1', name: 'Admin', role: 'ADMIN', email: 'admin@example.com' }
  emailStatus = 'SENT'
  programs.set('program-1', { id: 'program-1', slug: 'leadership', titleAr: 'دبلوم القيادة', titleEn: 'Leadership Diploma', active: false })
}

function jsonReq(body: AnyRecord = {}, url = 'https://aactacademy.test/api/admin/legacy-graduates') {
  return { json: async () => body, formData: async () => new FormData(), nextUrl: new URL(url) } as any
}

function formReq(form: FormData, url: string) {
  return { formData: async () => form, json: async () => ({}), nextUrl: new URL(url) } as any
}

async function responseJson(res: Response) {
  return await res.json() as AnyRecord
}

async function minimalPdf() {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.addPage([240, 160])
  return Buffer.from(await pdf.save())
}

function makeStoredZip(fileName: string, data: Buffer) {
  const name = Buffer.from(fileName)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  const localRecord = Buffer.concat([local, name, data])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt32LE(0, 42)
  const centralRecord = Buffer.concat([central, name])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralRecord.length, 12)
  eocd.writeUInt32LE(localRecord.length, 16)
  return Buffer.concat([localRecord, centralRecord, eocd])
}

beforeEach(resetState)

describe('legacy graduates admin authorization', () => {
  test('non-admin receives 403 on legacy graduate admin routes', async () => {
    currentAdmin = null
    expect((await adminLegacyRoute.GET(jsonReq())).status).toBe(403)
    expect((await adminLegacyRoute.POST(jsonReq({}))).status).toBe(403)
    expect((await adminLegacyRoute.PATCH(jsonReq({ id: 'cert-1' }))).status).toBe(403)
    expect((await importRoute.POST(jsonReq())).status).toBe(403)
    expect((await uploadRoute.POST(jsonReq(), { params: { certificateId: 'cert-1' } } as any)).status).toBe(403)
    expect((await importFilesRoute.POST(jsonReq())).status).toBe(403)
    expect((await resendRoute.POST(jsonReq(), { params: { certificateId: 'cert-1' } } as any)).status).toBe(403)
  })
})

describe('legacy graduate creation', () => {
  test('new graduate creates user enrollment and linked certificate', async () => {
    const result = await createLegacyGraduate({ name: 'ليلى أحمد', email: ' LEILA@EXAMPLE.COM ', programId: 'program-1', grade: 'امتياز', finalScore: 96, issuedAt: new Date('2024-06-30T00:00:00Z'), legacySerial: 'OLD-1' }, currentAdmin as any)
    expect(result.user.email).toBe('leila@example.com')
    expect(result.enrollment.status).toBe('COMPLETED')
    expect(result.enrollment.finalScore).toBe(96)
    expect(result.certificate.userId).toBe(result.user.id)
    expect(result.certificate.enrollmentId).toBe(result.enrollment.id)
    expect(result.certificate.legacy).toBe(true)
    expect(result.certificate.serial).toBe('AACT-C-2026-00001')
    expect(enrollments.get(enrollmentKey(result.user.id, 'program-1'))?.certificateNo).toBe(result.certificate.serial)
  })

  test('existing email reuses the same user and does not create a duplicate account', async () => {
    users.set('user-existing', { id: 'user-existing', email: 'student@example.com', name: 'Student', role: 'STUDENT', status: 'ACTIVE' })
    const result = await createLegacyGraduate({ name: 'Student', email: 'student@example.com', programId: 'program-1', issuedAt: new Date('2024-01-01T00:00:00Z') }, currentAdmin as any)
    expect(result.user.id).toBe('user-existing')
    expect(result.userCreated).toBe(false)
    expect(users.size).toBe(1)
  })

  test('email failure does not roll back the created graduate operation', async () => {
    emailStatus = 'FAILED'
    const res = await adminLegacyRoute.POST(jsonReq({ name: 'مها', email: 'maha@example.com', programId: 'program-1', issuedAt: '2024-06-30' }))
    const data = await responseJson(res)
    expect(res.status).toBe(201)
    expect(data.emailStatus).toBe('FAILED')
    expect(users.size).toBe(1)
    expect(certificates.size).toBe(1)
  })

  test('duplicate legacySerial is rejected', async () => {
    certificates.set('cert-existing', { id: 'cert-existing', legacy: true, legacySerial: 'DUP-1', serial: 'AACT-C-2026-99999', qrToken: 'token-old', type: 'PROGRAM_COMPLETION', holderName: 'Old', program: 'دبلوم القيادة', valid: true })
    await expect(createLegacyGraduate({ name: 'سامر', email: 'samer@example.com', programId: 'program-1', issuedAt: new Date(), legacySerial: 'DUP-1' }, currentAdmin as any)).rejects.toThrow('رقم الشهادة الورقية مستخدم مسبقاً')
  })
})

describe('legacy graduate spreadsheet import helpers', () => {
  test('Arabic xlsx headers parse correctly and Excel numeric dates convert correctly without saving', async () => {
    const XLSX = await import('xlsx')
    const excelSerial = Math.floor(Date.UTC(2024, 5, 30) / 86400000) + 25569
    const sheet = XLSX.utils.aoa_to_sheet([
      ['الاسم', 'الإيميل', 'الجوال', 'الدولة', 'البرنامج', 'التقدير', 'المعدل', 'تاريخ التخرج', 'رقم الشهادة'],
      ['أحمد', 'ahmad@example.com', '0599000000', 'فلسطين', 'leadership', 'امتياز', 95, excelSerial, 'OLD-XLSX-1'],
      ['خطأ', 'bad-email', '', '', 'leadership typo', '', '', '31/13/2024', 'OLD-XLSX-2'],
    ])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
    const beforeUsers = users.size
    const parsed = parseLegacyGraduateWorkbook(Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer), 'legacy.xlsx')
    const rows = await validateLegacyGraduateImportRows(parsed)
    expect(rows[0].email).toBe('ahmad@example.com')
    expect(rows[0].issuedAt?.toISOString().slice(0, 10)).toBe('2024-06-30')
    expect(rows[0].errors).toHaveLength(0)
    expect(rows[1].errors).toContain('إيميل غلط')
    expect(rows[1].errors).toContain('برنامج مش موجود')
    expect(rows[1].programSuggestion).toContain('leadership')
    expect(users.size).toBe(beforeUsers)
  })
})

describe('legacy certificate file upload stamping and download', () => {
  test('PDF upload stores original and stamped files and certificate download returns stamped PDF', async () => {
    const user = { id: 'user-1', email: 'grad@example.com', name: 'Grad', role: 'STUDENT', status: 'ACTIVE' }
    users.set(user.id, user)
    certificates.set('cert-1', { id: 'cert-1', legacy: true, serial: 'AACT-C-2026-00001', qrToken: 'qr-1', type: 'PROGRAM_COMPLETION', holderName: 'Grad', program: 'دبلوم القيادة', valid: true, userId: user.id, issuedAt: new Date('2024-06-30T00:00:00Z') })
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('qrPosition', 'BOTTOM_LEFT')
    fd.append('qrSize', 'M')
    const uploadRes = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/legacy-graduates/cert-1/upload'), { params: { certificateId: 'cert-1' } } as any)
    expect(uploadRes.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toBeTruthy()
    expect(cert.stampedFileKey).toBeTruthy()
    const downloadRes = await pdfRoute.GET(jsonReq({}, 'https://aactacademy.test/api/pdf/certificates/AACT-C-2026-00001'), { params: { id: 'AACT-C-2026-00001' } } as any)
    expect(downloadRes.status).toBe(200)
    expect(downloadRes.headers.get('Content-Type')).toBe('application/pdf')
  })

  test('non-PDF and non-image uploads are rejected', async () => {
    certificates.set('cert-1', { id: 'cert-1', legacy: true, serial: 'AACT-C-2026-00001', qrToken: 'qr-1', type: 'PROGRAM_COMPLETION', holderName: 'Grad', program: 'دبلوم القيادة', valid: true, issuedAt: new Date() })
    const fd = new FormData()
    fd.append('file', new File([Buffer.from('not a certificate')], 'bad.txt', { type: 'text/plain' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/legacy-graduates/cert-1/upload'), { params: { certificateId: 'cert-1' } } as any)
    expect(res.status).toBe(400)
    expect(sniffLegacyCertificateMime(Buffer.from('not a certificate'))).toBeNull()
  })

  test('certificate without uploaded file downloads generated template PDF fallback', async () => {
    certificates.set('cert-1', { id: 'cert-1', legacy: true, serial: 'AACT-C-2026-00001', qrToken: 'qr-1', type: 'PROGRAM_COMPLETION', holderName: 'Grad', program: 'دبلوم القيادة', valid: true, issuedAt: new Date() })
    const res = await pdfRoute.GET(jsonReq({}, 'https://aactacademy.test/api/pdf/certificates/AACT-C-2026-00001'), { params: { id: 'AACT-C-2026-00001' } } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  test('ZIP import reports missing owner without stopping other files', async () => {
    const zip = makeStoredZip('missing@example.com.pdf', await minimalPdf())
    const fd = new FormData()
    fd.append('file', new File([zip], 'legacy.zip', { type: 'application/zip' }))
    const res = await importFilesRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/legacy-graduates/import-files'))
    const data = await responseJson(res)
    expect(res.status).toBe(200)
    expect(data.notFound).toBe(1)
    expect(data.results[0].status).toBe('NOT_FOUND')
  })
})

describe('legacy certificate verification', () => {
  test('QR verification returns certificate and revoked legacy certificate is invalid', async () => {
    certificates.set('cert-1', { id: 'cert-1', legacy: true, serial: 'AACT-C-2026-00001', legacySerial: 'OLD-VERIFY-1', qrToken: 'verify-token', type: 'PROGRAM_COMPLETION', holderName: 'Grad', program: 'دبلوم القيادة', grade: 'امتياز', valid: true, issuedAt: new Date() })
    const okRes = await verifyRoute.GET(jsonReq({}, 'https://aactacademy.test/api/certificates/verify?token=verify-token'))
    const ok = await responseJson(okRes)
    expect(ok.valid).toBe(true)
    expect(ok.certificate.serial).toBe('AACT-C-2026-00001')
    const cert = certificates.get('cert-1')!
    cert.valid = false
    cert.revokedAt = new Date('2026-01-01T00:00:00Z')
    const revokedRes = await verifyRoute.GET(jsonReq({}, 'https://aactacademy.test/api/certificates/verify?serial=OLD-VERIFY-1'))
    const revoked = await responseJson(revokedRes)
    expect(revoked.valid).toBe(false)
    expect(revoked.message).toContain('ملغاة')
  })
})
