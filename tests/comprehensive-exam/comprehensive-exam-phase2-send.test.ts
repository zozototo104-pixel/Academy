// Comprehensive exam phase 2 — invite sending (email + WhatsApp).
// Real send function; mail/WhatsApp/config are faked and switchable.
import { describe, expect, mock, test } from 'bun:test'

let settings: Record<string, string> = {}
let emailBehavior: 'SENT' | 'SKIPPED' | 'FAILED' | 'THROW' = 'SENT'
let whatsappBehavior: 'OK' | 'THROW' = 'OK'
let sentEmails: any[] = []
let sentWhatsApps: any[] = []
let archivedWhatsApps: any[] = []
let archiveBehavior: 'OK' | 'THROW' = 'OK'
let returnedMessageId: string | null = 'wamid.exam-invite-1'
let applications: Record<string, { country: string | null }> = {}
let usersById: Record<string, { country: string | null }> = {}

mock.module('@/lib/db', () => ({
  db: {
    setting: {
      findUnique: async ({ where }: any) => (settings[where?.key] ? { key: where.key, value: settings[where.key] } : null),
    },
    admissionApplication: {
      findUnique: async ({ where }: any) => applications[where?.id] || null,
    },
    user: {
      findUnique: async ({ where }: any) => usersById[where?.id] || null,
    },
  },
}))
mock.module('@/lib/mailer', () => ({
  emailTemplate: (title: string, body: string, cta?: any) => `<h1>${title}</h1>${body}`,
  sendEmailDetailed: async (input: any) => {
    if (emailBehavior === 'THROW') throw new Error('SMTP connection refused')
    sentEmails.push(input)
    return emailBehavior
  },
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  sendOfficialWhatsAppTemplate: async (to: string, template: string, params: string[], options?: { languageCode?: string; wabaId?: string; headerImageUrl?: string }) => {
    if (whatsappBehavior === 'THROW') throw new Error('Meta: insufficient balance (402)')
    sentWhatsApps.push({ to, template, params, options })
    return { messages: returnedMessageId ? [{ id: returnedMessageId }] : [] }
  },
}))
mock.module('@/lib/whatsapp-conversations', () => ({
  recordWhatsAppOutboundMessage: async (args: any) => {
    if (archiveBehavior === 'THROW') throw new Error('Database temporarily unavailable')
    archivedWhatsApps.push(args)
    return { id: 'conversation-new-recipient' }
  },
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async () => ({ key: 'k', mimeType: 'image/png', size: 1 }),
}))

const lib = await import('../../src/lib/comprehensive-exam-phase2')

function reset() {
  settings = {}
  emailBehavior = 'SENT'
  whatsappBehavior = 'OK'
  sentEmails = []
  sentWhatsApps = []
  archivedWhatsApps = []
  applications = {}
  usersById = {}
  archiveBehavior = 'OK'
  returnedMessageId = 'wamid.exam-invite-1'
  delete process.env.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE
  delete process.env.COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE
  delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
}

const inviteInput = () => ({
  fullName: 'أحمد محمد',
  email: 'a@b.com',
  phone: '0599123456',
  examTitle: 'الامتحان الشامل — إدارة الأعمال',
  programTitle: 'الماجستير المهني في إدارة الأعمال',
  durationMin: 120,
  inviteUrl: 'https://aactacademy.com/comprehensive-exam/abc123',
  expiresAt: new Date('2026-12-03T00:00:00Z'),
})

describe('template name resolution', () => {
  test('setting wins, env is the fallback, null when neither', async () => {
    reset()
    expect(await lib.readComprehensiveExamWhatsAppTemplate()).toBeNull()
    process.env.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'env_template_ar'
    expect(await lib.readComprehensiveExamWhatsAppTemplate()).toBe('env_template_ar')
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'setting_template_ar'
    expect(await lib.readComprehensiveExamWhatsAppTemplate()).toBe('setting_template_ar')
  })
  test('language defaults to ar, prefers admin setting, and accepts ar_EG', async () => {
    reset()
    expect(await lib.readComprehensiveExamWhatsAppLanguage()).toBe('ar')
    process.env.COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE = 'en_US'
    expect(await lib.readComprehensiveExamWhatsAppLanguage()).toBe('en_US')
    settings.COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE = 'ar_EG'
    expect(await lib.readComprehensiveExamWhatsAppLanguage()).toBe('ar_EG')
  })
  test('WABA ID is optional and uses admin settings before server env', async () => {
    reset()
    expect(await lib.readComprehensiveExamWhatsAppWabaId()).toBe('')
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = '123456789000'
    expect(await lib.readComprehensiveExamWhatsAppWabaId()).toBe('123456789000')
    settings.COMPREHENSIVE_EXAM_WHATSAPP_WABA_ID = '987654321000'
    expect(await lib.readComprehensiveExamWhatsAppWabaId()).toBe('987654321000')
  })
})

describe('sendComprehensiveExamInvite', () => {
  test('both channels sent, template name from settings, 4 body params in order', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    settings['COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE'] = 'ar_EG'
    settings['COMPREHENSIVE_EXAM_WHATSAPP_WABA_ID'] = '123456789000'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('SENT')
    expect(d.whatsapp.status).toBe('SENT')
    expect(sentEmails[0].to).toBe('a@b.com')
    expect(sentWhatsApps[0].template).toBe('comprehensive_exam_invite_ar')
    expect(sentWhatsApps[0].params[0]).toBe('أحمد محمد')
    expect(sentWhatsApps[0].params[1]).toBe('الامتحان الشامل — إدارة الأعمال')
    expect(sentWhatsApps[0].params[3]).toBe('https://aactacademy.com/comprehensive-exam/abc123')
    expect(sentWhatsApps[0].params.length).toBe(4)
    expect(sentWhatsApps[0].options).toEqual({ languageCode: 'ar_EG', wabaId: '123456789000', headerImageUrl: 'https://www.aactacademy.com/logo.png' })
    expect(archivedWhatsApps).toHaveLength(1)
    expect(archivedWhatsApps[0]).toMatchObject({
      waId: '0599123456',
      displayName: 'أحمد محمد',
      sender: 'SYSTEM',
      whatsappMessageId: 'wamid.exam-invite-1',
      rawType: 'template',
      requireSavedMessage: true,
      meta: { templateName: 'comprehensive_exam_invite_ar', languageCode: 'ar_EG' },
    })
    expect(archivedWhatsApps[0].text).toContain('https://aactacademy.com/comprehensive-exam/abc123')
  })
  test('invite passes the platform logo as the header image (template IMAGE header, Meta #132012)', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.whatsapp.status).toBe('SENT')
    expect(sentWhatsApps[0].options.headerImageUrl).toBe('https://www.aactacademy.com/logo.png')
  })
  test('legacy configuration still sends Arabic ar without requiring WABA ID', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'legacy_invite'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.whatsapp.status).toBe('SENT')
    expect(sentWhatsApps[0].options).toEqual({ languageCode: 'ar', wabaId: '', headerImageUrl: undefined })
  })
  test('missing template name: WhatsApp NOT_CONFIGURED with a clear reason, email still sent', async () => {
    reset()
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('SENT')
    expect(d.whatsapp.status).toBe('NOT_CONFIGURED')
    expect(d.whatsapp.error).toContain('قالب واتساب')
    expect(sentWhatsApps.length).toBe(0)
    expect(archivedWhatsApps).toHaveLength(0)
  })
  test('WhatsApp provider failure: FAILED with the provider message, email still sent', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    whatsappBehavior = 'THROW'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('SENT')
    expect(d.whatsapp.status).toBe('FAILED')
    expect(d.whatsapp.error).toContain('insufficient balance')
    expect(archivedWhatsApps).toHaveLength(0)
  })
  test('email skipped (mailer unconfigured): SKIPPED, WhatsApp still sent', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    emailBehavior = 'SKIPPED'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('SKIPPED')
    expect(d.whatsapp.status).toBe('SENT')
  })
  test('email throws: FAILED with the reason, WhatsApp still sent', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    emailBehavior = 'THROW'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('FAILED')
    expect(d.email.error).toContain('SMTP connection refused')
    expect(d.whatsapp.status).toBe('SENT')
  })
  test('invalid phone: WhatsApp FAILED, email still sent', async () => {
    reset()
    settings['COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE'] = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), phone: 'abc' })
    expect(d.email.status).toBe('SENT')
    expect(d.whatsapp.status).toBe('FAILED')
    expect(archivedWhatsApps).toHaveLength(0)
  })
  test('Meta accepts the invite but archive fails: do not misreport a failed send', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    archiveBehavior = 'THROW'
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.email.status).toBe('SENT')
    expect(d.whatsapp.status).toBe('SENT')
    expect(d.whatsapp.error).toContain('تعذّر حفظ الرسالة')
    expect(sentWhatsApps).toHaveLength(1)
    expect(archivedWhatsApps).toHaveLength(0)
  })
  test('Meta accepts without a message id: archive the template but warn about delivery tracking', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    returnedMessageId = null
    const d = await lib.sendComprehensiveExamInvite(inviteInput())
    expect(d.whatsapp.status).toBe('SENT')
    expect(d.whatsapp.error).toContain('معرّف الرسالة')
    expect(archivedWhatsApps).toHaveLength(1)
    expect(archivedWhatsApps[0].whatsappMessageId).toBeNull()
  })
})

describe('archive waId normalisation (country-aware)', () => {
  test('Palestine local number archives under 972', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    settings.COMPREHENSIVE_EXAM_WHATSAPP_LANGUAGE = 'ar_EG'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), country: 'فلسطين' })
    expect(d.whatsapp.status).toBe('SENT')
    expect(sentWhatsApps[0].to).toBe('0599123456')
    expect(archivedWhatsApps).toHaveLength(1)
    expect(archivedWhatsApps[0].waId).toBe('972599123456')
  })
  test('Saudi local number with the same 059 prefix archives under 966, not 972', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), country: 'السعودية' })
    expect(d.whatsapp.status).toBe('SENT')
    expect(sentWhatsApps[0].to).toBe('0599123456')
    expect(archivedWhatsApps).toHaveLength(1)
    expect(archivedWhatsApps[0].waId).toBe('966599123456')
  })
  test('already-international number is archived untouched', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), phone: '+972599123456', country: 'فلسطين' })
    expect(d.whatsapp.status).toBe('SENT')
    expect(archivedWhatsApps[0].waId).toBe('972599123456')
  })
  test('Palestinian 970 number without plus is preserved in the archive', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), phone: '970599123456', country: 'فلسطين' })
    expect(d.whatsapp.status).toBe('SENT')
    expect(archivedWhatsApps[0].waId).toBe('970599123456')
  })
  test('unknown country keeps the number as stored — never guessed', async () => {
    reset()
    settings.COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE = 'comprehensive_exam_invite_ar'
    const d = await lib.sendComprehensiveExamInvite({ ...inviteInput(), country: 'أخرى' })
    expect(d.whatsapp.status).toBe('SENT')
    expect(archivedWhatsApps[0].waId).toBe('0599123456')
  })
})

describe('resolveComprehensiveInviteCountry', () => {
  test('application country wins over the user country', async () => {
    reset()
    applications['adm-1'] = { country: 'السعودية' }
    usersById['user-1'] = { country: 'فلسطين' }
    expect(await lib.resolveComprehensiveInviteCountry({ admissionApplicationId: 'adm-1', userId: 'user-1' })).toBe('السعودية')
  })
  test('falls back to the user country when there is no application', async () => {
    reset()
    usersById['user-1'] = { country: 'فلسطين' }
    expect(await lib.resolveComprehensiveInviteCountry({ admissionApplicationId: null, userId: 'user-1' })).toBe('فلسطين')
  })
  test('null when neither has a country', async () => {
    reset()
    expect(await lib.resolveComprehensiveInviteCountry({ admissionApplicationId: null, userId: null })).toBeNull()
  })
})
