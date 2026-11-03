import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'

// Guard suite for the single-snapshot backup change (2026-11-02):
// createDatabaseBackup must read EVERY table inside ONE RepeatableRead
// transaction, through the transaction client only, and must fail loudly
// (BACKUP_SNAPSHOT_FAILED) before any file is stored when a table errors.

process.env.AACT_BACKUP_ENCRYPTION_KEY = 'guard-test-key-for-backup-snapshot-suite-0123456789'

const state = {
  txOpts: [] as any[],
  stored: [] as any[],
  dbDelegateUsed: false,
  failNotification: false,
}

function makeDelegate(rows: any[], fail = () => false) {
  return {
    count: async () => rows.length,
    findMany: async ({ skip = 0, take = rows.length }: any) => {
      if (fail()) throw new Error('simulated table read failure')
      return rows.slice(skip, skip + take)
    },
  }
}

const txDelegates = {
  setting: makeDelegate([{ key: 'GUARD' }]),
  user: makeDelegate([{ id: 'u1' }, { id: 'u2' }]),
  notification: makeDelegate([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }], () => state.failNotification),
}

const tripwire = () => {
  state.dbDelegateUsed = true
  throw new Error('DB_DELEGATE_USED_OUTSIDE_TRANSACTION')
}

mock.module('@prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' },
    dmmf: {
      datamodel: {
        models: [
          { name: 'Setting', primaryKey: null, uniqueFields: [['key']], fields: [{ name: 'key', kind: 'scalar', type: 'String', isId: true }] },
          { name: 'User', primaryKey: null, uniqueFields: [['id']], fields: [{ name: 'id', kind: 'scalar', type: 'String', isId: true }, { name: 'email', kind: 'scalar', type: 'String' }] },
          {
            name: 'Notification', primaryKey: null, uniqueFields: [['id']],
            fields: [
              { name: 'id', kind: 'scalar', type: 'String', isId: true },
              { name: 'userId', kind: 'scalar', type: 'String' },
              { name: 'user', kind: 'object', type: 'User', relationFromFields: ['userId'] },
            ],
          },
          { name: 'Session', primaryKey: null, uniqueFields: [['id']], fields: [{ name: 'id', kind: 'scalar', type: 'String', isId: true }] },
        ],
      },
    },
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    $transaction: async (fn: any, opts: any) => {
      state.txOpts.push(opts)
      return fn(txDelegates)
    },
    setting: { count: tripwire, findMany: tripwire },
    user: { count: tripwire, findMany: tripwire },
    notification: { count: tripwire, findMany: tripwire },
    session: { count: tripwire, findMany: tripwire },
  },
}))

mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => {
    state.stored.push(input)
    return { provider: 'local', key: `${input.namespace}/${input.fileName}`, size: input.buffer.length, mimeType: input.mimeType }
  },
  readStoredFile: async () => null,
  storageErrorMessage: (e: any) => e?.message || String(e),
}))

mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
mock.module('next/server', () => ({ NextRequest: class {} }))

const { createDatabaseBackup } = await import('../../src/lib/backups')

beforeEach(() => {
  state.txOpts = []
  state.stored = []
  state.dbDelegateUsed = false
  state.failNotification = false
})

describe('نسخة احتياطية من لقطة واحدة متسقة', () => {
  test('كل الجداول تُقرأ داخل معاملة واحدة بمستوى RepeatableRead ومهلة مناسبة', async () => {
    const result: any = await createDatabaseBackup('cron')
    expect(result.ok).toBe(true)
    expect(state.txOpts.length).toBe(1)
    expect(state.txOpts[0].isolationLevel).toBe('RepeatableRead')
    expect(state.txOpts[0].timeout).toBeGreaterThanOrEqual(60000)
    expect(state.txOpts[0].maxWait).toBeGreaterThanOrEqual(5000)
  })

  test('القراءات عبر عميل المعاملة فقط، والعدّادات كاملة، وملف واحد يُخزّن', async () => {
    const result: any = await createDatabaseBackup('cron')
    expect(state.dbDelegateUsed).toBe(false)
    expect(result.counts).toEqual({ Setting: 1, User: 2, Notification: 3 })
    expect(state.stored.length).toBe(1)
  })

  test('فشل أي جدول يوقف النسخ بصوت عالٍ ولا يُخزّن أي ملف', async () => {
    state.failNotification = true
    let message = ''
    try {
      await createDatabaseBackup('cron')
    } catch (e: any) {
      message = e?.message || String(e)
    }
    expect(message).toContain('BACKUP_SNAPSHOT_FAILED')
    expect(message).toContain('Notification')
    expect(state.stored.length).toBe(0)
  })

  test('دبابيس ثابتة على كود المصدر', () => {
    const src = readFileSync('src/lib/backups.ts', 'utf8')
    expect(src).toContain('isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead')
    expect(src).toContain('const delegate = (tx as any)[table.delegate]')
    expect(src).not.toContain('const delegate = (db as any)[table.delegate]')
    expect(src).toContain('BACKUP_SNAPSHOT_FAILED')
  })
})
