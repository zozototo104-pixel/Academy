import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const seriesRoute = readFileSync('src/app/api/admin/lectures/series/route.ts', 'utf8')
const postponeRoute = readFileSync('src/app/api/admin/lectures/sessions/[id]/postpone/route.ts', 'utf8')
const sessionsList = readFileSync('src/app/api/admin/lectures/sessions/list/route.ts', 'utf8')
const videosList = readFileSync('src/app/api/admin/lectures/videos/list/route.ts', 'utf8')
const confirmRoute = readFileSync('src/app/api/admin/lectures/videos/upload/confirm/route.ts', 'utf8')
const embed = readFileSync('src/lib/lectures/video-embed.ts', 'utf8')

describe('R-01/R-04: series creation scope and supervisor role', () => {
  test('a non-admin must already manage the program to create a series in it', () => {
    expect(seriesRoute).toContain('canManageProgram(actor, input.programId)')
    const scopeCheck = seriesRoute.indexOf('canManageProgram(actor, input.programId)')
    const create = seriesRoute.indexOf('db.$transaction')
    expect(scopeCheck).toBeGreaterThan(-1)
    expect(scopeCheck).toBeLessThan(create)
  })

  test('the assigned supervisor role is validated', () => {
    expect(seriesRoute).toContain("supervisor.role !== 'SUPERVISOR'")
    expect(seriesRoute).toContain("supervisor.role !== 'ADMIN'")
    expect(seriesRoute).toContain('select: { id: true, role: true }')
  })
})

describe('R-03: admin list endpoints respect the feature flag', () => {
  test('both lists return 404 when lectures are disabled', () => {
    for (const src of [sessionsList, videosList]) {
      expect(src).toContain('isLecturesEnabled()')
      expect(src).toContain('status: 404')
    }
  })
})

describe('R-05: strict host matching in the video parser', () => {
  test('hostIs requires the domain itself or a true subdomain', () => {
    expect(embed).toContain("host.endsWith(`.${domain}`)")
    expect(embed).not.toContain("host.endsWith('youtube.com')")
    expect(embed).not.toContain("host.endsWith('facebook.com')")
    expect(embed).not.toContain("host.endsWith('mediadelivery.net')")
  })
})

describe('R-06: upload confirmation enforces the real content type', () => {
  test('confirm rejects stored types outside the allowlist', () => {
    expect(confirmRoute).toContain('LECTURE_UPLOAD_TYPES')
    expect(confirmRoute).toContain('!(head.contentType in LECTURE_UPLOAD_TYPES)')
  })
})

describe('R-07: compound writes are transactional', () => {
  test('series create + sessions, and postpone create + update, use $transaction', () => {
    expect(seriesRoute).toContain('db.$transaction')
    expect(seriesRoute).toContain('tx.lectureSession.createMany')
    expect(postponeRoute).toContain('db.$transaction')
    expect(postponeRoute).toContain('tx.lectureSession.update')
  })
})
