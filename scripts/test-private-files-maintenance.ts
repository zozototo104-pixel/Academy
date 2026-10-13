import { promises as dns } from 'dns'
import { NextRequest } from 'next/server'
import { runPrivateFilesMaintenanceBatch } from '../src/lib/private-files-maintenance'
import { __privateFilesMaintenancePostForTests } from '../src/app/api/admin/maintenance/private-files/route'
import { readStoredFile } from '../src/lib/storage'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function makeMockDb() {
  const settings = new Map<string, { key: string; value: string; updatedAt: Date }>()
  const auditLogs: any[] = []
  const admissions = new Map<string, any>([
    ['adm-doc-1', { id: 'adm-doc-1', storageKey: null, fileUrl: '/uploads/admissions/adm-doc-1.pdf' }],
  ])
  const emptyModel = { findMany: async () => [] }
  const db: any = {
    setting: {
      create: async ({ data }: any) => {
        if (settings.has(data.key)) {
          const error: any = new Error('Unique constraint failed')
          error.code = 'P2002'
          throw error
        }
        settings.set(data.key, { ...data, updatedAt: new Date() })
        return settings.get(data.key)
      },
      findUnique: async ({ where }: any) => settings.get(where.key) || null,
      updateMany: async ({ where, data }: any) => {
        const current = settings.get(where.key)
        if (!current) return { count: 0 }
        if (where.updatedAt?.lt && !(current.updatedAt < where.updatedAt.lt)) return { count: 0 }
        settings.set(where.key, { ...current, ...data, updatedAt: new Date() })
        return { count: 1 }
      },
      update: async ({ where, data }: any) => {
        const current = settings.get(where.key)
        if (!current) throw new Error('SETTING_NOT_FOUND')
        const next = { ...current, ...data, updatedAt: new Date() }
        settings.set(where.key, next)
        return next
      },
      delete: async ({ where }: any) => {
        settings.delete(where.key)
        return null
      },
    },
    auditLog: { create: async ({ data }: any) => { auditLogs.push(data); return data } },
    admissionDocument: {
      findMany: async () => [...admissions.values()].map((row) => ({ ...row })),
      update: async ({ where, data }: any) => {
        const current = admissions.get(where.id)
        if (!current) throw new Error('ADMISSION_DOCUMENT_NOT_FOUND')
        const next = { ...current, ...data }
        admissions.set(where.id, next)
        return next
      },
    },
    paymentProof: emptyModel,
    assignmentSubmission: emptyModel,
    thesisSubmission: emptyModel,
    serviceDeliverable: emptyModel,
  }
  return { db, admissions, auditLogs, settings }
}

function makeStorage(privateKeys = new Set<string>(), options: { localKeys?: Set<string>; readLegacyFile?: (item: any) => Promise<{ buffer: Buffer; mimeType: string } | null> } = {}) {
  let storeCalls = 0
  const localKeys = options.localKeys || new Set<string>(['admissions/adm-doc-1.pdf'])
  const storage = {
    privateFileExists: async (key: string) => privateKeys.has(key),
    localLegacyExists: async (key: string) => localKeys.has(key),
    readLegacyFile: options.readLegacyFile || (async () => ({ buffer: Buffer.from('legacy-file'), mimeType: 'application/pdf' })),
    storePrivateFile: async (item: any) => { storeCalls += 1; privateKeys.add(item.key) },
    downloadPathForKey: (key: string) => `/api/files/${key}`,
  }
  return { storage, privateKeys, getStoreCalls: () => storeCalls }
}

async function testDryRunDoesNotMutate() {
  const { db, admissions, auditLogs } = makeMockDb()
  const { storage, getStoreCalls } = makeStorage()
  const report = await runPrivateFilesMaintenanceBatch({ db, mode: 'dry-run', batchSize: 50, storage, actor: { id: 'admin-1', name: 'Admin' } })
  assert(report.byType.AdmissionDocument.toMigrate === 1, 'dry-run must report one admission document to migrate')
  assert(admissions.get('adm-doc-1')?.storageKey === null, 'dry-run must not update storageKey')
  assert(getStoreCalls() === 0, 'dry-run must not copy files')
  assert(auditLogs.length === 1, 'dry-run batch must be written to AuditLog')
}

async function testExecuteUpdatesAndIsIdempotent() {
  const { db, admissions, auditLogs } = makeMockDb()
  const { storage, getStoreCalls } = makeStorage()
  let rejected = false
  try {
    await runPrivateFilesMaintenanceBatch({ db, mode: 'execute', batchSize: 50, storage, actor: { id: 'admin-1', name: 'Admin' } })
  } catch (error: any) {
    rejected = String(error?.message || error) === 'PRIVATE_FILES_CONFIRM_REQUIRED'
  }
  assert(rejected, 'execute without confirm must be rejected')

  const first = await runPrivateFilesMaintenanceBatch({ db, mode: 'execute', confirm: 'نعم انقل', batchSize: 50, storage, actor: { id: 'admin-1', name: 'Admin' } })
  assert(first.byType.AdmissionDocument.toMigrate === 1, 'execute must migrate the admission document once')
  assert(admissions.get('adm-doc-1')?.storageKey === 'admissions/adm-doc-1.pdf', 'execute must update storageKey')
  assert(admissions.get('adm-doc-1')?.fileUrl === '/api/files/admissions/adm-doc-1.pdf', 'execute must replace public URL with protected path')
  assert(getStoreCalls() === 1, 'execute must copy the old file once')

  const second = await runPrivateFilesMaintenanceBatch({ db, mode: 'execute', confirm: 'نعم انقل', batchSize: 50, storage, actor: { id: 'admin-1', name: 'Admin' } })
  assert(second.byType.AdmissionDocument.alreadyPrivate === 1, 'second execute must treat the file as already private')
  assert(getStoreCalls() === 1, 'second execute must not copy the file again')
  assert(auditLogs.length === 2, 'each successful execute batch must be written to AuditLog')
}

async function testRouteRejectsNonAdmin() {
  const { db } = makeMockDb()
  const { storage } = makeStorage()
  const req = new NextRequest('https://academy.test/api/admin/maintenance/private-files', {
    method: 'POST',
    body: JSON.stringify({ mode: 'dry-run' }),
  })
  const response = await __privateFilesMaintenancePostForTests(req, {
    db,
    storage,
    requireAdmin: async () => { throw new Error('UNAUTHORIZED') },
  })
  assert(response.status === 403, 'non-admin user must receive 403')
}

async function testDetailedReportCategoriesAndInvalidKeys() {
  const oldHosts = process.env.PRIVATE_FILES_ALLOWED_LEGACY_HOSTS
  process.env.PRIVATE_FILES_ALLOWED_LEGACY_HOSTS = 'allowed.test'
  try {
    const { db, admissions } = makeMockDb()
    admissions.set('adm-local-2', { id: 'adm-local-2', storageKey: null, fileUrl: '/uploads/admissions/local-2.pdf' })
    admissions.set('adm-external', { id: 'adm-external', storageKey: null, fileUrl: 'https://allowed.test/uploads/admissions/external.pdf' })
    admissions.set('adm-bad-host', { id: 'adm-bad-host', storageKey: null, fileUrl: 'https://evil.test/uploads/admissions/blocked.pdf' })
    admissions.set('adm-missing-key', { id: 'adm-missing-key', storageKey: null, fileUrl: 'not-a-private-file-reference' })
    const { storage } = makeStorage(new Set(), { localKeys: new Set(['admissions/adm-doc-1.pdf', 'admissions/local-2.pdf']) })
    const report = await runPrivateFilesMaintenanceBatch({ db, mode: 'dry-run', batchSize: 50, storage })
    const admission = report.byType.AdmissionDocument
    assert(admission.localOnServer === 2, 'report must count files موجود محلياً على الخادم')
    assert(admission.externalUrl === 1, 'report must count allowed رابط خارجي files')
    assert(admission.disallowedHost === 1 && admission.disallowedHostIds.includes('adm-bad-host'), 'report must count مضيف غير مسموح with id')
    assert(admission.missing === 1 && admission.missingIds.includes('adm-missing-key'), 'invalid keys must be counted as missing with id')
  } finally {
    if (oldHosts === undefined) delete process.env.PRIVATE_FILES_ALLOWED_LEGACY_HOSTS
    else process.env.PRIVATE_FILES_ALLOWED_LEGACY_HOSTS = oldHosts
  }
}

async function testTooLargeFilesAreReportedAndNotStored() {
  const { db, admissions } = makeMockDb()
  admissions.set('adm-big', { id: 'adm-big', storageKey: null, fileUrl: '/uploads/admissions/big.pdf' })
  const { storage, getStoreCalls } = makeStorage(new Set(), {
    localKeys: new Set(['admissions/adm-doc-1.pdf', 'admissions/big.pdf']),
    readLegacyFile: async (item: any) => ({ buffer: Buffer.alloc(item.id === 'adm-big' ? 10 : 1), mimeType: 'application/pdf' }),
  })
  const report = await runPrivateFilesMaintenanceBatch({ db, mode: 'execute', confirm: 'نعم انقل', batchSize: 50, storage, maxFileBytes: 5 })
  const admission = report.byType.AdmissionDocument
  assert(admission.tooLarge === 1 && admission.tooLargeIds.includes('adm-big'), 'large files must be reported as كبير جداً')
  assert(getStoreCalls() === 1, 'large files must not be stored while smaller files still migrate')
}

async function testBatchStopsBeforeDeadlineAndReturnsCursor() {
  const { db, admissions } = makeMockDb()
  admissions.set('adm-doc-2', { id: 'adm-doc-2', storageKey: null, fileUrl: '/uploads/admissions/adm-doc-2.pdf' })
  admissions.set('adm-doc-3', { id: 'adm-doc-3', storageKey: null, fileUrl: '/uploads/admissions/adm-doc-3.pdf' })
  const { storage } = makeStorage(new Set(), { localKeys: new Set(['admissions/adm-doc-1.pdf', 'admissions/adm-doc-2.pdf', 'admissions/adm-doc-3.pdf']) })
  const report = await runPrivateFilesMaintenanceBatch({ db, mode: 'dry-run', batchSize: 3, storage, deadlineMs: Date.now() + 1 })
  assert(report.processed === 1, 'adaptive batch must process at least one item before stopping')
  assert(report.done === false && Boolean(report.nextCursor), 'adaptive batch must return nextCursor when it stops before deadline')
}

async function testLockReleasedOnErrorForSameRun() {
  const { db, settings } = makeMockDb()
  const { storage } = makeStorage(new Set(), {
    readLegacyFile: async () => { throw new Error('boom') },
  })
  let failed = false
  try {
    await runPrivateFilesMaintenanceBatch({ db, mode: 'execute', confirm: 'نعم انقل', batchSize: 50, storage })
  } catch {
    failed = true
  }
  assert(failed, 'failing private file maintenance run must surface the error')
  assert(!settings.has('MAINTENANCE_PRIVATE_FILES_LOCK'), 'lock must be released in finally when the same run fails')
}

async function main() {
  await testDryRunDoesNotMutate()
  await testExecuteUpdatesAndIsIdempotent()
  await testRouteRejectsNonAdmin()
  await testDetailedReportCategoriesAndInvalidKeys()
  await testTooLargeFilesAreReportedAndNotStored()
  await testBatchStopsBeforeDeadlineAndReturnsCursor()
  await testLockReleasedOnErrorForSameRun()
  console.log('✓ private files maintenance behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
