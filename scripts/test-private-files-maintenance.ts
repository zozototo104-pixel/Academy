import { NextRequest } from 'next/server'
import { runPrivateFilesMaintenanceBatch } from '../src/lib/private-files-maintenance'
import { __privateFilesMaintenancePostForTests } from '../src/app/api/admin/maintenance/private-files/route'

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
  return { db, admissions, auditLogs }
}

function makeStorage(privateKeys = new Set<string>()) {
  let storeCalls = 0
  const storage = {
    privateFileExists: async (key: string) => privateKeys.has(key),
    localLegacyExists: async (key: string) => key === 'admissions/adm-doc-1.pdf',
    readLegacyFile: async () => ({ buffer: Buffer.from('legacy-file'), mimeType: 'application/pdf' }),
    storePrivateFile: async (item: any) => { storeCalls += 1; privateKeys.add(item.key) },
    downloadPathForKey: (key: string) => `/api/files/${key}`,
  }
  return { storage, privateKeys, getStoreCalls: () => storeCalls }
}

async function testDryRunDoesNotMutate() {
  const { db, admissions } = makeMockDb()
  const { storage, getStoreCalls } = makeStorage()
  const report = await runPrivateFilesMaintenanceBatch({ db, mode: 'dry-run', batchSize: 50, storage, actor: { id: 'admin-1', name: 'Admin' } })
  assert(report.byType.AdmissionDocument.toMigrate === 1, 'dry-run must report one admission document to migrate')
  assert(admissions.get('adm-doc-1')?.storageKey === null, 'dry-run must not update storageKey')
  assert(getStoreCalls() === 0, 'dry-run must not copy files')
}

async function testExecuteUpdatesAndIsIdempotent() {
  const { db, admissions } = makeMockDb()
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

async function main() {
  await testDryRunDoesNotMutate()
  await testExecuteUpdatesAndIsIdempotent()
  await testRouteRejectsNonAdmin()
  console.log('✓ private files maintenance behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
