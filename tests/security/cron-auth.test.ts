// حارس كرون ai-retention (فحص 2026-10-30، بند الكرون): المسار كان
// «يفشل مفتوحاً» — بلا أي سر مضبوط كان أول زائر بلا دخول يشغّل حذف
// محادثات الذكاء القديمة. كل مسارات الكرون الأخرى تفشل مُغلقة.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let cleanupCalls = 0
mock.module('@/lib/ai-retention', () => ({
  cleanupOldAiConversations: async () => { cleanupCalls++; return { deletedConversations: 0, deletedMessages: 0 } },
}))

const route = await import('@/app/api/cron/ai-retention/route')

const SAVED = { cron: process.env.CRON_SECRET, backup: process.env.BACKUP_CRON_SECRET }

beforeEach(() => {
  cleanupCalls = 0
  delete process.env.CRON_SECRET
  delete process.env.BACKUP_CRON_SECRET
})

afterEach(() => {
  if (SAVED.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SAVED.cron
  if (SAVED.backup === undefined) delete process.env.BACKUP_CRON_SECRET; else process.env.BACKUP_CRON_SECRET = SAVED.backup
})

function get(headers: Record<string, string> = {}) {
  return route.GET(new NextRequest('http://x/api/cron/ai-retention', { headers }))
}

describe('كرون ai-retention يفشل مُغلقاً', () => {
  test('بلا أي سر مضبوط: زائر بلا ترويسة يُرفض ولا يعمل الحذف', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(cleanupCalls).toBe(0)
  })

  test('سر مضبوط وبلا ترويسة: يُرفض', async () => {
    process.env.CRON_SECRET = 's3cret'
    const res = await get()
    expect(res.status).toBe(401)
    expect(cleanupCalls).toBe(0)
  })

  test('سر مضبوط وترويسة خاطئة: يُرفض', async () => {
    process.env.CRON_SECRET = 's3cret'
    const res = await get({ authorization: 'Bearer wrong' })
    expect(res.status).toBe(401)
    expect(cleanupCalls).toBe(0)
  })

  test('السر الصحيح Bearer: يعمل', async () => {
    process.env.CRON_SECRET = 's3cret'
    const res = await get({ authorization: 'Bearer s3cret' })
    expect(res.status).toBe(200)
    expect(cleanupCalls).toBe(1)
  })

  test('سر النسخ الاحتياطي عبر x-cron-secret: يعمل (سلوك قائم محفوظ)', async () => {
    process.env.BACKUP_CRON_SECRET = 'bkp'
    const res = await get({ 'x-cron-secret': 'bkp' })
    expect(res.status).toBe(200)
    expect(cleanupCalls).toBe(1)
  })
})
