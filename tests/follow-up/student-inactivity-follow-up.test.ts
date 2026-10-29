import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard: Inactivity follow-up engine (student follow-up service, phase 1).
// Locked rules: 3 consecutive days with ZERO activity -> one follow-up per
// day on platform + email + WhatsApp; after 3 messages sending stops and
// the derived status is needs-intervention; any activity resets the counter.
// WhatsApp outside the 24h window goes out as the approved template, inside
// the window as free-form text — the same fork as the verification button.

const NOW = new Date('2026-10-29T06:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

let fixtures: any[] = []
let conversation: any = null
let notifyCalls: any[] = []
let emailCalls: any[] = []
let waTextCalls: any[] = []
let waTemplateCalls: any[] = []
let outboundRecords: any[] = []
let logRows: any[] = []
let enrollmentUpdates: any[] = []
let findManyArgs: any = null

mock.module('@/lib/db', () => ({
  db: {
    enrollment: {
      findMany: async (args: any) => {
        findManyArgs = args
        return fixtures
      },
      update: async (args: any) => {
        enrollmentUpdates.push(args)
        return {}
      },
    },
    studentFollowUpLog: {
      create: async ({ data }: any) => {
        logRows.push(data)
        return { id: 'log-1' }
      },
    },
    whatsAppConversation: {
      findUnique: async () => conversation,
    },
  },
}))

mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => {
    notifyCalls.push(args)
  },
}))

mock.module('@/lib/mailer', () => ({
  sendEmail: async (args: any) => {
    emailCalls.push(args)
    return { ok: true }
  },
  emailTemplate: (title: string, body: string) => `<html>${title}${body}</html>`,
}))

mock.module('@/lib/whatsapp-cloud', () => ({
  officialWhatsAppConfigured: () => true,
  sendOfficialWhatsAppText: async (to: string, text: string) => {
    waTextCalls.push({ to, text })
    return { messages: [{ id: 'wamid.text' }] }
  },
  sendOfficialWhatsAppHumanFollowup: async (to: string, name: string) => {
    waTemplateCalls.push({ to, name })
    return { messages: [{ id: 'wamid.template' }] }
  },
}))

mock.module('@/lib/whatsapp-conversations', () => ({
  hashWhatsAppId: (digits: string) => `hash:${digits}`,
  recordWhatsAppOutboundMessage: async (args: any) => {
    outboundRecords.push(args)
    return { conversation: null, message: null }
  },
}))

const { processInactivityFollowUps, computeFollowUpStatus } = await import('@/lib/student-follow-up')

function enrollment(overrides: Record<string, any> = {}) {
  return {
    id: 'enr-1',
    status: 'ACTIVE',
    createdAt: daysAgo(30),
    followUpCount: 0,
    lastFollowUpAt: null,
    program: { id: 'prog-1', titleAr: 'برنامج تجريبي' },
    user: {
      id: 'user-1',
      name: 'طالب تجريبي',
      email: 'student@example.com',
      phone: '970599000000',
      lastActivityAt: daysAgo(1),
    },
    ...overrides,
  }
}

beforeEach(() => {
  fixtures = []
  conversation = null
  notifyCalls = []
  emailCalls = []
  waTextCalls = []
  waTemplateCalls = []
  outboundRecords = []
  logRows = []
  enrollmentUpdates = []
  findManyArgs = null
})

describe('processInactivityFollowUps', () => {
  test('queries only study-phase enrollments (ACTIVE / SUPERVISOR_ASSIGNED)', async () => {
    await processInactivityFollowUps(NOW)
    expect(findManyArgs.where.status.in).toEqual(['ACTIVE', 'SUPERVISOR_ASSIGNED'])
  })

  test('absent 2 days: nothing is sent and nothing is logged', async () => {
    fixtures = [enrollment({ user: { ...enrollment().user, lastActivityAt: daysAgo(2) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(0)
    expect(notifyCalls).toHaveLength(0)
    expect(emailCalls).toHaveLength(0)
    expect(waTextCalls).toHaveLength(0)
    expect(waTemplateCalls).toHaveLength(0)
    expect(logRows).toHaveLength(0)
    expect(enrollmentUpdates).toHaveLength(0)
  })

  test('absent 3 days, WhatsApp window closed: platform + email + approved template, log + counter', async () => {
    conversation = { lastInboundAt: daysAgo(5) }
    fixtures = [enrollment({ user: { ...enrollment().user, lastActivityAt: daysAgo(3) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(1)
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0][1]).toBe('FOLLOW_UP')
    expect(emailCalls).toHaveLength(1)
    expect(emailCalls[0].event).toBe('STUDENT_FOLLOW_UP')
    expect(waTextCalls).toHaveLength(0)
    expect(waTemplateCalls).toHaveLength(1)
    expect(outboundRecords).toHaveLength(1)
    expect(outboundRecords[0].sender).toBe('SYSTEM')
    expect(logRows).toHaveLength(1)
    expect(logRows[0].kind).toBe('INACTIVITY_MESSAGE')
    expect(logRows[0].messageIndex).toBe(1)
    expect(logRows[0].daysAbsent).toBe(3)
    expect(logRows[0].whatsappStatus).toBe('TEMPLATE')
    expect(logRows[0].emailSent).toBe(true)
    expect(enrollmentUpdates).toHaveLength(1)
    expect(enrollmentUpdates[0].data.followUpCount).toBe(1)
    expect(enrollmentUpdates[0].data.lastFollowUpAt).toEqual(NOW)
  })

  test('absent 4 days, WhatsApp window open: free-form text instead of the template', async () => {
    conversation = { lastInboundAt: new Date(NOW.getTime() - 60 * 60 * 1000) }
    fixtures = [enrollment({ followUpCount: 1, lastFollowUpAt: daysAgo(1), user: { ...enrollment().user, lastActivityAt: daysAgo(4) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(1)
    expect(waTextCalls).toHaveLength(1)
    expect(waTemplateCalls).toHaveLength(0)
    expect(logRows[0].whatsappStatus).toBe('TEXT')
    expect(logRows[0].messageIndex).toBe(2)
  })

  test('three messages already sent: sending stops and the student counts as needs-intervention', async () => {
    fixtures = [enrollment({ followUpCount: 3, lastFollowUpAt: daysAgo(1), user: { ...enrollment().user, lastActivityAt: daysAgo(9) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(0)
    expect(stats.needsIntervention).toBe(1)
    expect(notifyCalls).toHaveLength(0)
    expect(logRows).toHaveLength(0)
  })

  test('already sent today: no duplicate message the same day', async () => {
    fixtures = [enrollment({ followUpCount: 1, lastFollowUpAt: NOW, user: { ...enrollment().user, lastActivityAt: daysAgo(5) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(0)
    expect(notifyCalls).toHaveLength(0)
  })

  test('student returned (absent 1 day with an open counter): counter resets and the return is logged', async () => {
    fixtures = [enrollment({ followUpCount: 2, lastFollowUpAt: daysAgo(1), user: { ...enrollment().user, lastActivityAt: daysAgo(1) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(0)
    expect(stats.returned).toBe(1)
    expect(enrollmentUpdates).toHaveLength(1)
    expect(enrollmentUpdates[0].data.followUpCount).toBe(0)
    expect(enrollmentUpdates[0].data.lastFollowUpAt).toBeNull()
    expect(logRows).toHaveLength(1)
    expect(logRows[0].kind).toBe('RETURNED')
  })

  test('no valid phone: WhatsApp is skipped but platform + email still go out', async () => {
    fixtures = [enrollment({ user: { ...enrollment().user, phone: null, lastActivityAt: daysAgo(3) } })]
    const stats = await processInactivityFollowUps(NOW)
    expect(stats.sent).toBe(1)
    expect(notifyCalls).toHaveLength(1)
    expect(emailCalls).toHaveLength(1)
    expect(waTextCalls).toHaveLength(0)
    expect(waTemplateCalls).toHaveLength(0)
    expect(logRows[0].whatsappStatus).toBe('SKIPPED')
  })
})

describe('computeFollowUpStatus', () => {
  test('falls back to the enrollment baseline when no activity stamp exists yet', () => {
    const status = computeFollowUpStatus({ lastActivityAt: null, baselineAt: daysAgo(2), followUpCount: 0 }, NOW)
    expect(status.daysAbsent).toBe(2)
    expect(status.needsIntervention).toBe(false)
  })

  test('needs-intervention is derived: 3+ days absent AND 3 messages sent', () => {
    const status = computeFollowUpStatus({ lastActivityAt: daysAgo(6), baselineAt: daysAgo(30), followUpCount: 3 }, NOW)
    expect(status.daysAbsent).toBe(6)
    expect(status.needsIntervention).toBe(true)
  })

  test('a returned student is never needs-intervention even with 3 old messages', () => {
    const status = computeFollowUpStatus({ lastActivityAt: daysAgo(1), baselineAt: daysAgo(30), followUpCount: 3 }, NOW)
    expect(status.needsIntervention).toBe(false)
  })
})
