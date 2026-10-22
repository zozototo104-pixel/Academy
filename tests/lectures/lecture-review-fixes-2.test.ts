import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const videosRoute = readFileSync('src/app/api/admin/lectures/videos/route.ts', 'utf8')
const watchRoute = readFileSync('src/app/api/my/lecture-videos/[videoId]/watch/route.ts', 'utf8')
const confirmRoute = readFileSync('src/app/api/admin/lectures/videos/upload/confirm/route.ts', 'utf8')
const videosList = readFileSync('src/app/api/admin/lectures/videos/list/route.ts', 'utf8')
const adminUi = readFileSync('src/components/aact/AdminLectures.tsx', 'utf8')

describe('S-01L: manual storage keys are closed end to end', () => {
  test('the create API rejects storageKey and sizeBytes outright', () => {
    expect(videosRoute).toContain("'storageKey' in rawBody || 'sizeBytes' in rawBody")
    expect(videosRoute).toContain('لا تُقبل مفاتيح التخزين أو الأحجام يدويًا')
    expect(videosRoute).toContain("source === 'S3'")
    expect(videosRoute).toContain('storageKey: null')
  })

  test('the admin UI has no manual storage-key field anymore', () => {
    expect(adminUi).not.toContain('مفتاح التخزين (Storage Key)')
    expect(adminUi).toContain('لا تُدخل مفاتيح تخزين يدويًا')
  })

  test('the watch route signs only lecture-upload keys (defense in depth)', () => {
    expect(watchRoute).toContain('LECTURE_UPLOAD_PREFIX')
    expect(watchRoute).toContain('!video.storageKey.startsWith(LECTURE_UPLOAD_PREFIX)')
    const prefixCheck = watchRoute.indexOf('startsWith(LECTURE_UPLOAD_PREFIX)')
    const signing = watchRoute.indexOf('createLectureVideoSignedUrl(video.storageKey)')
    expect(prefixCheck).toBeGreaterThan(-1)
    expect(prefixCheck).toBeLessThan(signing)
  })
})

describe('S-02L: confirmation rejects a missing content type', () => {
  test('null contentType is refused like a wrong one', () => {
    expect(confirmRoute).toContain('!head.contentType || !(head.contentType in LECTURE_UPLOAD_TYPES)')
  })
})

describe('S-03L: list filter intersects with supervisor scope', () => {
  test('no duplicate programId key; explicit intersection with empty result out of scope', () => {
    expect(videosList).toContain('programScope.includes(programId)')
    expect(videosList).not.toContain('...(programScope ? { programId: { in: programScope } } : {})')
    expect(videosList).toContain('...programFilter')
  })
})
