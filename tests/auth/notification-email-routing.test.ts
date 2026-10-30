import { describe, expect, mock, test } from 'bun:test'

// The real mailer, with only the db mocked: SMTP/Resend are unconfigured, so
// every send lands as SKIPPED — but the emailLog row records the FINAL
// recipient, which is exactly what the notification-email reroute decides.
const logs: any[] = []
const dbMock = {
  user: {
    findUnique: async ({ where }: any) =>
      where.email === 'old@student.com' ? { notificationEmail: 'inbox@new.com' } : null,
  },
  setting: { findMany: async () => [] },
  emailLog: { create: async ({ data }: any) => { logs.push(data); return data } },
}
mock.module('@/lib/db', () => ({ db: dbMock }))

const mailer = await import('@/lib/mailer')

describe('notification email routing in sendEmailDetailed', () => {
  test('ordinary platform mail is delivered to the confirmed notification email, not the full login mailbox', async () => {
    logs.length = 0
    await mailer.sendEmail({ to: 'old@student.com', subject: 'نتيجة اختبار', event: 'TEST_EVENT', html: '<p>أهلاً</p>' })
    expect(logs.length).toBe(1)
    expect(logs[0].to).toBe('inbox@new.com')
  })

  test('password reset stays on the LOGIN email (identity mail never reroutes)', async () => {
    logs.length = 0
    await mailer.emailPasswordReset('old@student.com', 'طالب', 'https://example.test/reset?token=x')
    expect(logs.length).toBe(1)
    expect(logs[0].to).toBe('old@student.com')
  })

  test('account verification stays on the exact address given', async () => {
    logs.length = 0
    await mailer.emailVerifyAccount('old@student.com', 'طالب', 'https://example.test/verify?token=x')
    expect(logs.length).toBe(1)
    expect(logs[0].to).toBe('old@student.com')
  })

  test('an email-change confirmation goes to the NEW address itself (it is not a login email, so no reroute)', async () => {
    logs.length = 0
    await mailer.emailEmailChangeConfirm('fresh@new.com', 'طالب', 'https://example.test/verify?token=x', 'NOTIFICATION')
    expect(logs.length).toBe(1)
    expect(logs[0].to).toBe('fresh@new.com')
  })

  test('an address with no account/notification email is delivered unchanged', async () => {
    logs.length = 0
    await mailer.sendEmail({ to: 'someone@else.com', subject: 'رسالة', event: 'TEST_EVENT', html: '<p>أهلاً</p>' })
    expect(logs.length).toBe(1)
    expect(logs[0].to).toBe('someone@else.com')
  })
})
