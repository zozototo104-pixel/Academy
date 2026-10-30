import { describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// مفتاح الختم قبل أي استيراد يستهلك secret-crypto.
process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

// ---------------------------------------------------------------------------
// فك ختم الأسرار عند القراءة (تدقيق ٢٠٢٦-١٠-٣٠، الوحدة ٥): إعدادات النظام
// تُختم مشفرة عند حفظها من اللوحة متى حمل اسمها KEY/CREDENTIAL/SECRET…،
// وموقعان كانا يقرآن الخام: rtcConfig مكالمات المشرف الصوتية
// (TURN_CREDENTIAL) وتشكيل وكيل الذكاء المحلي (AI_AGENT_API_KEY) — فكان
// النص المشفر نفسه سيُستعمل كلمةَ سر/مفتاحاً يوم تُحفظ القيمة من اللوحة.
// القيم غير المشفرة تمر كما هي (unsealSettingSecret تمرير آمن).
// ---------------------------------------------------------------------------

const { encryptSecret } = await import('@/lib/secret-crypto')

const settings = new Map<string, string>([
  ['TURN_URL', 'turn:turn.example.com:3478'],
  ['TURN_USERNAME', 'academy-turn'],
  ['TURN_CREDENTIAL', encryptSecret('turn-plain-secret')],
  ['AI_AGENT_BASE_URL', 'https://agent.example.com/v1'],
  ['AI_AGENT_MODEL', 'qwen-agent'],
  ['AI_AGENT_API_KEY', encryptSecret('agent-plain-key')],
])

mock.module('@/lib/db', () => ({
  db: {
    setting: {
      findUnique: async ({ where }: any) => {
        const value = settings.get(where.key)
        return value === undefined ? null : { key: where.key, value }
      },
    },
    admissionApplication: {
      findUnique: async ({ where }: any) =>
        where?.id === 'app-1'
          ? { id: 'app-1', userId: 'student-1', email: 'student@example.com', supervisorId: 'sup-1', supervisor: { id: 'sup-1', name: 'المشرف' } }
          : null,
    },
    supervisorVoiceCall: {
      findFirst: async () => null,
      findUnique: async () => null,
      updateMany: async () => ({ count: 0 }),
    },
  },
}))

mock.module('@/lib/auth', () => ({
  requireUser: async () => ({ id: 'admin-1', role: 'ADMIN', name: 'الأدمن', email: 'admin@example.com' }),
  getCurrentUser: async () => ({ id: 'admin-1', role: 'ADMIN', name: 'الأدمن', email: 'admin@example.com' }),
}))

mock.module('@/lib/notify', () => ({ notify: async () => {}, audit: async () => {} }))

const voiceRoute = await import('@/app/api/supervisor/voice-call/route')
const { localAgentConfig } = await import('@/lib/open-source-llm')

describe('قراءة الأسرار المختمة: فك الختم عند الاستهلاك', () => {
  test('مكالمة المشرف الصوتية: بيانات TURN تصل مفكوكة الختم إلى rtcConfig', async () => {
    const res = await voiceRoute.GET(new NextRequest('http://localhost/api/supervisor/voice-call?admissionId=app-1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    const turn = (body.rtcConfig?.iceServers || []).find((s: any) => Array.isArray(s.urls) && s.urls.some((u: string) => u.startsWith('turn:')))
    expect(turn).toBeTruthy()
    expect(turn.username).toBe('academy-turn')
    expect(turn.credential).toBe('turn-plain-secret')
  })

  test('وكيل الذكاء المحلي: مفتاح الإعدادات يصل مفكوك الختم', async () => {
    const cfg = await localAgentConfig()
    expect(cfg.apiKey).toBe('agent-plain-key')
    expect(cfg.source).toBe('settings')
    expect(cfg.enabled).toBe(true)
  })

  test('قيمة غير مشفرة محفوظة قديماً تمر كما هي دون كسر', async () => {
    settings.set('TURN_CREDENTIAL', 'legacy-plain-value')
    try {
      const res = await voiceRoute.GET(new NextRequest('http://localhost/api/supervisor/voice-call?admissionId=app-1'))
      const body = await res.json()
      const turn = (body.rtcConfig?.iceServers || []).find((s: any) => Array.isArray(s.urls) && s.urls.some((u: string) => u.startsWith('turn:')))
      expect(turn?.credential).toBe('legacy-plain-value')
    } finally {
      settings.set('TURN_CREDENTIAL', encryptSecret('turn-plain-secret'))
    }
  })
})
