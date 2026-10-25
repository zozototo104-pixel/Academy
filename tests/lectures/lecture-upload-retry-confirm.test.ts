import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

// Guard for the retry-confirm button Haris's stuck drafts need (2026-10-25):
// uploads reached R2 storage twice, but the browser never saw the PUT
// response, so confirm never ran and the drafts stayed unconfirmed with no
// way to recover short of re-uploading. The button reuses the existing
// confirm endpoint, so this test pins that endpoint's contract: an object
// present in storage confirms (size recorded), an absent object is refused
// with 409 instead of silently succeeding.

let headResult: { sizeBytes: number; contentType: string } | null = {
  sizeBytes: 30 * 1024 * 1024,
  contentType: 'video/mp4',
}
const updateCalls: any[] = []

const video = {
  id: 'v1',
  programId: 'p1',
  source: 'S3',
  storageKey: 'lectures/videos/abc.mp4',
  mimeType: 'video/mp4',
  sizeBytes: null,
}

mock.module('@/lib/db', () => ({
  db: {
    lectureVideoResource: {
      findUnique: async () => video,
      update: async (args: any) => {
        updateCalls.push(args)
        return { ...video, sizeBytes: BigInt(args.data.sizeBytes) }
      },
    },
  },
}))
mock.module('@/lib/lectures/manage', () => ({
  requireLectureManager: async () => ({ id: 'admin-1', role: 'ADMIN' }),
  canManageProgram: async () => true,
  auditLecture: async () => undefined,
}))
mock.module('@/lib/lectures/config', () => ({ isLecturesEnabled: () => true }))
mock.module('@/lib/lectures/video-storage', () => ({
  headLectureObject: async () => headResult,
  lectureVideoMaxBytes: () => 2 * 1024 * 1024 * 1024,
  LECTURE_UPLOAD_TYPES: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' },
}))

const postConfirm = async () => {
  const { POST } = await import('@/app/api/admin/lectures/videos/upload/confirm/route')
  return POST(
    new NextRequest('http://localhost/api/admin/lectures/videos/upload/confirm', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'v1' }),
    }),
  )
}

describe('lecture upload retry-confirm contract', () => {
  test('an object present in storage confirms and records its real size', async () => {
    headResult = { sizeBytes: 30 * 1024 * 1024, contentType: 'video/mp4' }
    updateCalls.length = 0
    const res = await postConfirm()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.confirmed).toBe(true)
    expect(body.video.sizeBytes).toBe(30 * 1024 * 1024)
    expect(updateCalls.length).toBe(1)
  })

  test('an absent object is refused with 409, never silently confirmed', async () => {
    headResult = null
    updateCalls.length = 0
    const res = await postConfirm()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('لم يصل الملف')
    expect(updateCalls.length).toBe(0)
  })

  test('the admin UI offers retry-confirm, gated on unconfirmed uploads', () => {
    const adminUi = readFileSync('src/components/aact/AdminLectures.tsx', 'utf8')
    expect(adminUi).toContain('إعادة تأكيد')
    expect(adminUi).toContain('/api/admin/lectures/videos/upload/confirm')
    // The button must live inside the unconfirmed-upload branch, never on
    // confirmed or link-based videos.
    const buttonAt = adminUi.indexOf('إعادة تأكيد')
    const gateAt = adminUi.lastIndexOf('unconfirmedUpload && (', buttonAt)
    expect(gateAt).toBeGreaterThan(-1)
  })
})
