/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { validateAdmissionFileSignature } from '../../src/lib/file-signature'
import { backupTableNames, backupTableSpecs } from '../../src/lib/backups'
import { Prisma } from '@prisma/client'
import { clientIpFromHeaders } from '../../src/lib/rate-limit'

describe('files C2 upload and backup safety', () => {
  test('magic bytes infer octet-stream uploads and reject mismatched extensions', () => {
    const pdf = Buffer.from('%PDF-1.7\nbody', 'utf8')
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: 'application/octet-stream' })).toMatchObject({ ok: true, mimeType: 'application/pdf' })
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: '' })).toMatchObject({ ok: true, mimeType: 'application/pdf' })
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.png', mimeType: 'image/png' }).ok).toBe(false)
    const valid = validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: 'application/pdf' })
    expect(valid).toMatchObject({ ok: true, mimeType: 'application/pdf' })
  })

  test('legacy OLE doc files are accepted as application/msword by extension', () => {
    const oleDoc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)])
    expect(validateAdmissionFileSignature({ buffer: oleDoc, fileName: 'file.doc', mimeType: 'application/octet-stream' })).toMatchObject({
      ok: true,
      kind: 'doc',
      mimeType: 'application/msword',
    })
  })

  test('database backup includes payment proofs waivers attempts and certificate templates', () => {
    const tables = backupTableNames()
    expect(tables).toContain('PaymentProof')
    expect(tables).toContain('PaymentWaiverCode')
    expect(tables).toContain('PaymentWaiverAttempt')
    expect(tables).toContain('CertificateTemplate')
  })

  test('backup model coverage follows Prisma without a manual allowlist', () => {
    const current = new Set(backupTableNames())
    const all = Object.keys(Prisma.ModelName)
    const omitted = all.filter((name) => !current.has(name))
    expect(omitted).toEqual(process.env.AACT_BACKUP_INCLUDE_SESSIONS === 'true' ? [] : ['Session'])
    expect(current.size).toBe(all.length - omitted.length)
    for (const name of ['LectureSession', 'LectureAttendance', 'BookChunk', 'BookOutline', 'AiUsageLog', 'QuestionRecheckTask', 'WhatsAppConversationMessage']) {
      expect(current.has(name)).toBe(true)
    }
  })

  test('backup restores model dependencies before their children', () => {
    const specs = backupTableSpecs()
    const positions = new Map(specs.map((spec, index) => [spec.name, index]))
    for (const model of Prisma.dmmf.datamodel.models) {
      const spec = specs.find((item) => item.name === model.name)
      expect(spec).toBeDefined()
      expect(Object.keys(spec!.orderBy).length).toBeGreaterThan(0)
      for (const field of model.fields) {
        if (field.kind !== 'object' || !(field.relationFromFields?.length) || field.type === model.name) continue
        expect(positions.get(field.type)!).toBeLessThan(positions.get(model.name)!)
      }
    }
  })

  test('database restore requires isolation, a complete backup and an empty target', () => {
    const backups = require('node:fs').readFileSync('src/lib/backups.ts', 'utf8')
    const cli = require('node:fs').readFileSync('scripts/backup-restore.ts', 'utf8')
    for (const source of [backups, cli]) {
      expect(source).toContain('AACT_RESTORE_ISOLATED_TARGET')
      expect(source).toContain('BACKUP_INCOMPLETE_SCHEMA_COVERAGE')
      expect(source).toContain('RESTORE_TARGET_NOT_EMPTY')
      expect(source).toContain('.$transaction(')
      expect(source).not.toContain('skipDuplicates: true')
    }
  })

  test('x-forwarded-for is trusted only for Vercel requests', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toBe('2.2.2.2')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1, 3.3.3.3', 'x-vercel-id': 'iad1::abc' }))).toBe('1.1.1.1')
  })
})
