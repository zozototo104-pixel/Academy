import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const cronRoute = readFileSync('src/app/api/cron/lecture-reminders/route.ts', 'utf8')
const adminUi = readFileSync('src/components/aact/AdminLectures.tsx', 'utf8')
const vercelJson = readFileSync('vercel.json', 'utf8')

describe('lecture reminders cron route source guards', () => {
  test('requires the CRON_SECRET bearer token and the feature flag', () => {
    expect(cronRoute).toContain('process.env.CRON_SECRET')
    expect(cronRoute).toContain('`Bearer ${secret}`')
    expect(cronRoute).toContain('isLecturesEnabled()')
  })

  test('claims each reminder atomically before sending', () => {
    expect(cronRoute).toContain('reminder24hSentAt: null')
    expect(cronRoute).toContain('reminder15mSentAt: null')
    // الترتيب مهم: المطالبة (updateMany) تأتي قبل الإشعار في نص الملف.
    expect(cronRoute.indexOf('updateMany')).toBeLessThan(cronRoute.indexOf('notifyProgramStudents(session'))
    expect(cronRoute).toContain('claim.count !== 1')
  })

  test('is registered in vercel.json on a 5-minute schedule', () => {
    expect(vercelJson).toContain('/api/cron/lecture-reminders')
    expect(vercelJson).toContain('"*/5 * * * *"')
  })
})

describe('lectures admin UI source guards', () => {
  test('talks only to the admin lectures endpoints', () => {
    for (const path of ['/api/admin/lectures/sessions/list', '/api/admin/lectures/videos/list', '/api/admin/lectures/series', '/api/admin/lectures/videos']) {
      expect(adminUi).toContain(path)
    }
    expect(adminUi).not.toContain('/api/my/')
  })

  test('carries the fixed provider-security notice and the unlisted advice', () => {
    expect(adminUi).toContain('غرفة الانتظار وكلمة المرور')
    expect(adminUi).toContain('غير المدرجة')
  })

  test('postpone converts the entered time in the series timezone', () => {
    expect(adminUi).toContain('zonedTimeToUtc')
  })

  test('times cannot be edited directly; attendance confirm uses the PATCH endpoint', () => {
    expect(adminUi).toContain('تغيير الموعد يتم من زر «تأجيل» حصرًا')
    expect(adminUi).toContain('/attendance')
    expect(adminUi).toContain("'PRESENT'")
    expect(adminUi).toContain("'ABSENT'")
  })
})
