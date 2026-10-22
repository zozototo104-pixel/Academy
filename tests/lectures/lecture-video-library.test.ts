import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { isUnconfirmedLectureUpload, LECTURE_VIDEO_URL_TTL_SEC } from '../../src/lib/lectures/video-storage'

const storageSrc = readFileSync('src/lib/storage.ts', 'utf8')
const videoStorage = readFileSync('src/lib/lectures/video-storage.ts', 'utf8')
const watchRoute = readFileSync('src/app/api/my/lecture-videos/[videoId]/watch/route.ts', 'utf8')
const videosRoute = readFileSync('src/app/api/admin/lectures/videos/route.ts', 'utf8')
const videoPatch = readFileSync('src/app/api/admin/lectures/videos/[id]/route.ts', 'utf8')
const uploadInit = readFileSync('src/app/api/admin/lectures/videos/upload/init/route.ts', 'utf8')
const uploadConfirm = readFileSync('src/app/api/admin/lectures/videos/upload/confirm/route.ts', 'utf8')
const player = readFileSync('src/components/aact/LecturePlayer.tsx', 'utf8')
const adminUi = readFileSync('src/components/aact/AdminLectures.tsx', 'utf8')
const schema = readFileSync('prisma/schema.prisma', 'utf8')

describe('lecture video storage independence', () => {
  test('the platform signer still clamps to 300s and is untouched by the lectures TTL', () => {
    expect(storageSrc).toContain('Math.min(300, Math.floor(expiresSeconds))')
    expect(LECTURE_VIDEO_URL_TTL_SEC).toBe(3600)
    expect(videoStorage).toContain("method: 'GET', key, expiresSec: LECTURE_VIDEO_URL_TTL_SEC")
  })

  test('unconfirmed upload detection: lectures prefix + no confirmed size', () => {
    expect(isUnconfirmedLectureUpload({ storageKey: 'lectures/videos/x.mp4', sizeBytes: null })).toBe(true)
    expect(isUnconfirmedLectureUpload({ storageKey: 'lectures/videos/x.mp4', sizeBytes: BigInt(10) })).toBe(false)
    expect(isUnconfirmedLectureUpload({ storageKey: 'legacy/manual.mp4', sizeBytes: null })).toBe(false)
    expect(isUnconfirmedLectureUpload({ storageKey: null, sizeBytes: null })).toBe(false)
  })

  test('WEBM exists in the schema enum and in an additive migration', () => {
    const enumBlock = schema.slice(schema.indexOf('enum LectureVideoSource'), schema.indexOf('enum LectureVideoStatus'))
    expect(enumBlock).toContain('WEBM')
    expect(existsSync('prisma/migrations/20261022120000_lectures_video_webm/migration.sql')).toBe(true)
    const migration = readFileSync('prisma/migrations/20261022120000_lectures_video_webm/migration.sql', 'utf8')
    expect(migration).toContain('ADD VALUE IF NOT EXISTS')
  })
})

describe('watch route and publish guard', () => {
  test('watch issues 1h lecture URLs and never serves unconfirmed uploads', () => {
    expect(watchRoute).toContain('createLectureVideoSignedUrl')
    expect(watchRoute).toContain('isUnconfirmedLectureUpload(video)')
    expect(watchRoute).not.toContain('createSignedStorageUrlForKey')
    expect(watchRoute).toContain('expiresInSec: LECTURE_VIDEO_URL_TTL_SEC')
  })

  test('publishing an unconfirmed upload is refused server-side', () => {
    expect(videoPatch).toContain('isUnconfirmedLectureUpload(video)')
    expect(videoPatch).toContain('status: 422')
  })
})

describe('upload flow guards', () => {
  test('init requires configuration, an allowed type and the size cap; starts unconfirmed', () => {
    expect(uploadInit).toContain('isLectureStorageConfigured()')
    expect(uploadInit).toContain('LECTURE_UPLOAD_TYPES')
    expect(uploadInit).toContain('lectureVideoMaxBytes()')
    expect(uploadInit).toContain('sizeBytes: null')
    expect(uploadInit).toContain("status: 'DRAFT'")
  })

  test('confirm verifies the object server-side before recording its size', () => {
    expect(uploadConfirm).toContain('headLectureObject(video.storageKey)')
    expect(uploadConfirm).toContain('status: 409')
    expect(uploadConfirm).toContain('BigInt(head.sizeBytes)')
  })

  test('the videos API auto-detects and rejects unsafe URLs', () => {
    expect(videosRoute).toContain('parseVideoUrl(input.url)')
    expect(videosRoute).toContain('الرابط غير آمن أو غير صالح')
  })
})

describe('player and admin UI wiring', () => {
  test('player: youtube api, vimeo postMessage, lazy hls, renewal, watermark', () => {
    expect(player).toContain('youtube.com/iframe_api')
    expect(player).toContain('player.vimeo.com')
    expect(player).toContain("import('hls.js')")
    expect(player).toContain('onRenew')
    expect(player).toContain('aspect-video')
  })

  test('admin UI: paste detection, direct upload with progress and cancel, reorder', () => {
    expect(adminUi).toContain('parseVideoUrl')
    expect(adminUi).toContain('/api/admin/lectures/videos/upload/init')
    expect(adminUi).toContain('/api/admin/lectures/videos/upload/confirm')
    expect(adminUi).toContain('XMLHttpRequest')
    expect(adminUi).toContain('بانتظار اكتمال الرفع')
    expect(adminUi).toContain('storageConfigured')
  })
})
