/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Regression guard for the gate #711 DEFENSE failure: the launch-quality
// defense probe («تصرف كعضو لجنة مناقشة. اسألني سؤالاً ذكياً…») was routed to
// the EXAMS agent because the probabilistic intent classifier's suggestion
// outranked the deterministic router — whose own law checks thesis-defense
// intent BEFORE exams. The fix gives explicit defense intent deterministic
// precedence in platformAgentComplete and platformAgentStream, mirroring the
// academic-student-question precedence. This suite drives the REAL completion
// functions with the classifier stubbed to suggest the WRONG agent, exactly
// the #711 condition.

let classifierSuggestion = 'EXAMS'

const studentRow = { id: 'student-1', name: 'طالب فحص', role: 'STUDENT', createdAt: new Date('2026-01-01T00:00:00Z') }
const anyDelegate: any = new Proxy({}, { get: () => async () => null })
const db: any = new Proxy(
  {
    user: { findUnique: async () => studentRow },
    auditLog: { create: async () => ({}) },
  },
  { get: (target: any, prop: string) => (prop in target ? target[prop] : anyDelegate) },
)

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai', () => ({
  OFFICIAL_INFO_UNAVAILABLE_REPLY: 'غير متاح رسميًا',
  chatComplete: async () => 'رد احتياطي طويل بما يكفي ليكون ردًا حقيقيًا من النموذج الاحتياطي في هذا المسار.',
}))
mock.module('@/lib/gemini', () => ({
  ensureGeminiKey: async () => true,
  geminiActiveTextModel: async () => 'gemini-test',
  geminiComplete: async () => 'إجابة نموذجية طويلة بما يكفي لتجاوز أي حد أدنى لطول الرد في هذا المسار التجريبي.',
  geminiCompleteJson: async () => JSON.stringify({
    intent: 'QUESTION',
    confidence: 0.9,
    suggestedAgent: classifierSuggestion,
    responseDepth: 'normal',
    shouldGreet: false,
  }),
  geminiDiscussionThinkingLevel: async () => 'high',
  geminiStreamText: async function* () {
    yield 'إجابة متدفقة طويلة بما يكفي لهذا المسار التجريبي.'
  },
}))
mock.module('@/lib/text-ai', () => ({
  textAiComplete: async () => 'رد الموجّه النصي في هذا المسار التجريبي.',
  textAiDiagnostics: async () => ({}),
  textAiModelHealthSnapshot: () => ({}),
}))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({}),
  getOfficialContact: async () => ({}),
}))
mock.module('@/lib/supervisor-ai', () => ({
  buildSupervisorContext: async () => 'سياق المشرف الأكاديمي للطالب.',
  mergeContext: (a: string, b: string) => [a, b].filter(Boolean).join('\n'),
  updateStudentAcademicMemory: async () => ({}),
}))
mock.module('@/lib/ai-context-builder', () => ({
  buildScopedDirectProgramBooksResult: async () => null,
  buildScopedProgramCatalogSnapshot: async () => '',
}))
mock.module('@/lib/ai-knowledge-policy', () => ({ resolveAiKnowledgeScope: () => ({}) }))
mock.module('@/lib/defense-agent-context', () => ({
  buildDefenseOnlyContextForStudent: async () => ({ context: 'سياق مناقشة البحث للطالب.' }),
}))
mock.module('@/lib/human-supervisor-context', () => ({
  buildHumanSupervisorAssignedStudentsContext: async () => '',
}))
mock.module('@/lib/open-source-llm', () => ({
  localAgentConfig: async () => null,
  localChatComplete: async () => '',
}))
mock.module('@/lib/payments', () => ({
  getGatewayConfig: async () => ({}),
  paymentDiagnostics: async () => ({}),
}))

const { platformAgentComplete, platformAgentStream } = await import('@/lib/platform-agent')

const DEFENSE_QUESTION = 'تصرف كعضو لجنة مناقشة. اسألني سؤالاً ذكياً عن بحثي أو تخصصي ثم وضّح لماذا هذا السؤال مهم.'
const PROFILE_QUESTION = 'عرّفني على ملفي الأكاديمي الحالي: اسمي، برنامجي، حالة طلبي، وما الذي يجب أن أركز عليه الآن؟'
const EXAM_QUESTION = 'ما هي درجة النجاح في امتحان الوحدة، وكيف يتم تصحيح الاختبار؟'
const GUIDANCE_QUESTION = 'ساعدني في اختيار عنوان بحث مناسب وخطة بحث لتخصصي'

function completeWith(question: string, suggestion: string) {
  classifierSuggestion = suggestion
  return platformAgentComplete({
    messages: [{ role: 'user', content: question }],
    mode: 'TEXT',
    userId: 'student-1',
  })
}

describe('platform agent defense-intent precedence', () => {
  test('the #711 DEFENSE probe question beats a classifier EXAMS suggestion', async () => {
    const result = await completeWith(DEFENSE_QUESTION, 'EXAMS')
    expect(result.agent).toBe('THESIS_DEFENSE')
  })

  test('the DEFENSE probe question still resolves THESIS_DEFENSE when the classifier agrees', async () => {
    const result = await completeWith(DEFENSE_QUESTION, 'THESIS_DEFENSE')
    expect(result.agent).toBe('THESIS_DEFENSE')
  })

  test('a genuine exam question keeps the EXAMS agent', async () => {
    const result = await completeWith(EXAM_QUESTION, 'EXAMS')
    expect(result.agent).toBe('EXAMS')
  })

  test('a student academic-file question keeps the ACADEMIC_SUPERVISOR precedence over the classifier', async () => {
    const result = await completeWith(PROFILE_QUESTION, 'ADMISSIONS')
    expect(result.agent).toBe('ACADEMIC_SUPERVISOR')
  })

  test('research-guidance questions are NOT swallowed by the defense override', async () => {
    const result = await completeWith(GUIDANCE_QUESTION, 'ACADEMIC_SUPERVISOR')
    expect(result.agent).toBe('ACADEMIC_SUPERVISOR')
  })

  test('the streaming path applies the same defense precedence', async () => {
    classifierSuggestion = 'EXAMS'
    const chunks: string[] = []
    const result = await platformAgentStream(
      { messages: [{ role: 'user', content: DEFENSE_QUESTION }], mode: 'TEXT', userId: 'student-1' },
      async (chunk: string) => { chunks.push(chunk) },
    )
    expect(result.agent).toBe('THESIS_DEFENSE')
  })

  test('source pins: both resolution sites consult defense intent before the classifier suggestion', () => {
    const source = readFileSync(new URL('../../src/lib/platform-agent.ts', import.meta.url), 'utf8')
    expect(source).toContain('const defenseQuestion = hasThesisDefenseIntent(normalizeArabic(last))')
    expect(source).toContain('academicStudentQuestion || defenseQuestion ? routeAgent(last, user?.role)')
    expect(source).toContain('defenseQuestion ? routeAgent(last, user?.role) : (intentAnalysis.suggestedAgent || routeAgent(last, user?.role))')
    // Both sites (Complete and Stream) must carry the precedence — the plain
    // substring above is also matched by the Complete line alone.
    expect(source.match(/defenseQuestion \? routeAgent/g)?.length).toBe(2)
  })
})
