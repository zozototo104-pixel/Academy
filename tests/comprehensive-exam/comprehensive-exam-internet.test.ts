// Comprehensive exam — AI-from-internet source: chunk building from
// Tavily snippets, prompt rules, and generation against a fake model
// reply. The DB is mocked (the lib's import chain pulls @/lib/db
// through gemini); search and AI completion are injected, so no real
// web search or model call is needed here.
import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/db', () => ({ db: {} }))

const lib = await import('../../src/lib/comprehensive-exam-internet')
const {
  buildInternetQuestionPrompt,
  clampInternetQuestionCount,
  formatInternetChunksForPrompt,
  generateInternetQuestions,
  diverseInternetEvidence,
  normalizeSpecialtyAxes,
  curriculumCoverageAxes,
  parseSuggestedSpecialtyAxes,
  buildSpecialtyResearchQueries,
  buildSpecialtyInternetQuery,
  internetSourceId,
  tavilyResultsToExamChunks,
} = lib

const SNIPPET_1 =
  'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد أو استهلاكها خلال دورة التشغيل العادية أو خلال سنة مالية واحدة أيهما أطول، وتشمل النقدية وما في حكمها والحسابات المدينة والمخزون والمصروفات المدفوعة مقدماً.'
const SNIPPET_2 =
  'الالتزامات المتداولة هي الالتزامات التي تستحق السداد خلال دورة التشغيل العادية أو خلال سنة مالية واحدة، وتشمل الحسابات الدائنة وأوراق الدفع قصيرة الأجل والمصروفات المستحقة والجزء المتداول من القروض طويلة الأجل.'
const EVIDENCE_1 =
  'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد أو استهلاكها خلال دورة التشغيل العادية'
const EVIDENCE_2 =
  'الالتزامات المتداولة هي الالتزامات التي تستحق السداد خلال دورة التشغيل العادية أو خلال سنة مالية واحدة'

const RESULTS = [
  { title: 'الأصول المتداولة — موسوعة المحاسبة', url: 'https://example.com/assets', content: SNIPPET_1, score: 0.9 },
  { title: 'الالتزامات المتداولة', url: 'https://example.com/liabilities', content: SNIPPET_2, score: 0.8 },
]

const GOOD_REPLY = JSON.stringify([
  {
    type: 'MCQ',
    text: 'أي مما يلي يُعد من الأصول المتداولة؟',
    options: ['النقدية', 'المباني', 'براءات الاختراع', 'الشهرة'],
    correctAnswer: 'النقدية',
    sourceIndex: 1,
    sourceEvidence: EVIDENCE_1,
    difficulty: 'EASY',
    rationale: 'النقدية تتحول إلى نقد فوراً فهي أصل متداول.',
  },
  {
    type: 'TF',
    text: 'الالتزامات المتداولة تستحق السداد خلال سنة مالية واحدة.',
    options: ['صح', 'خطأ'],
    correctAnswer: 'صح',
    sourceIndex: 2,
    sourceEvidence: EVIDENCE_2,
    difficulty: 'EASY',
    rationale: 'التعريف ينص على الاستحقاق خلال السنة المالية.',
  },
])

function fakeComplete(reply: string) {
  return async ({ validate }: any) => {
    validate(reply, { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })
    return { text: reply, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }
  }
}

const fakeVerify: any = async ({ questions }: any) => questions.map((question: any) => ({
  ...question,
  qualityFlags: ['SOURCE_GROUNDED'],
}))

describe('reviewable specialty blueprint', () => {
  const specialty = 'الدكتوراه المهنية في إدارة الأعمال'
  const titles = [
    'الإدارة الاستراتيجية وتحليل البيئة التنافسية', 'القيادة التحويلية والتغيير التنظيمي',
    'التحليل المالي واتخاذ القرارات الاستثمارية', 'مناهج البحث التطبيقي وتحليل البيانات',
    'إدارة المخاطر والحوكمة المؤسسية', 'إدارة العمليات وتحسين الأداء المؤسسي',
    'إدارة الموارد البشرية والسلوك التنظيمي', 'إدارة الابتكار والتحول الرقمي',
  ]
  test('rejects admissions, repeated titles and malformed AI proposals', () => {
    const axes = normalizeSpecialtyAxes([...titles, titles[0], 'مقدمة', 'شروط القبول في الدكتوراه'], specialty, 'CURRICULUM')
    expect(axes.map((axis: any) => axis.topic)).toEqual(titles)
    expect(parseSuggestedSpecialtyAxes('invalid', specialty)).toEqual([])
  })
  test('draws from the entire approved curriculum and combines research directions', () => {
    const many = Array.from({ length: 30 }, (_, i) => `تحليل الموضوع التخصصي ${i + 1} وتطبيقه في المؤسسات`)
    const axes = curriculumCoverageAxes(many, specialty)
    expect(axes).toHaveLength(10)
    expect(axes[0].topic).toContain('1')
    expect(axes[9].topic).toContain('30')
    expect(buildSpecialtyInternetQuery('القيادة التحويلية', specialty)).toContain('إدارة الأعمال')
    expect(new Set(buildSpecialtyResearchQueries('القيادة التحويلية', specialty)).size).toBe(3)
  })
})

async function expectCode(promise: Promise<unknown>): Promise<string> {
  let code = ''
  try {
    await promise
  } catch (e: any) {
    code = e?.code || ''
  }
  return code
}

describe('clampInternetQuestionCount / internetSourceId', () => {
  test('clamps into 1..10 and defaults on garbage', () => {
    expect(clampInternetQuestionCount(0)).toBe(1)
    expect(clampInternetQuestionCount(11)).toBe(10)
    expect(clampInternetQuestionCount('7')).toBe(7)
    expect(clampInternetQuestionCount(5.9)).toBe(5)
    expect(clampInternetQuestionCount(NaN)).toBe(5)
    expect(clampInternetQuestionCount(undefined)).toBe(5)
  })

  test('content-addressed synthetic id, never a real book id', () => {
    const a = internetSourceId('مبادئ المحاسبة')
    const b = internetSourceId('مبادئ المحاسبة')
    const c = internetSourceId('إدارة الأعمال')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('tavily:')).toBe(true)
  })
})

describe('tavilyResultsToExamChunks', () => {
  test('one chunk per usable snippet, short snippets and duplicate urls dropped', () => {
    const chunks = tavilyResultsToExamChunks(
      [
        ...RESULTS,
        { title: 'خلاصة قصيرة', url: 'https://example.com/short', content: 'نص قصير جداً.' },
        { title: 'مكرر', url: 'https://example.com/assets', content: SNIPPET_1 },
      ],
      'tavily:abc',
    )
    expect(chunks.length).toBe(2)
    expect(chunks.map((c: any) => c.sourceIndex)).toEqual([1, 2])
    expect(chunks[0].url).toBe('https://example.com/assets')
    expect(chunks[0].bookTitle).toBe('الأصول المتداولة — موسوعة المحاسبة')
    expect(chunks[0].textProvenance).toBe('NATIVE_TEXT')
    expect(chunks[0].bookId).toBe('tavily:abc')
    expect(chunks[1].url).toBe('https://example.com/liabilities')
  })

  test('prompt locator shows the source url next to the snippet', () => {
    const chunks = tavilyResultsToExamChunks(RESULTS, 'tavily:abc')
    const section = formatInternetChunksForPrompt(chunks)
    expect(section).toContain('[1] «الأصول المتداولة — موسوعة المحاسبة» — https://example.com/assets:')
    expect(section).toContain(SNIPPET_1)
  })
})

describe('diverseInternetEvidence', () => {
  test('samples all search directions and caps each domain to two cited pages', () => {
    const content = 'منهجية علمية مفصلة لتقييم البدائل الاستراتيجية وتحليل نتائج الدراسات ومقارنة القرارات المهنية تحت ظروف عدم اليقين.'
    const groups = Array.from({ length: 3 }, (_, angle) => Array.from({ length: 6 }, (_, i) => ({
      title: `بحث ${angle}-${i}`,
      url: `https://source${i % 3}.edu/study/${angle}-${i}`,
      content,
    })))
    const diverse = diverseInternetEvidence(groups)
    expect(diverse.results).toHaveLength(6)
    expect(diverse.distinctDomains).toBe(3)
    expect(diverse.results.some((item: any) => item.url.endsWith('0-0'))).toBe(true)
    expect(diverse.results.some((item: any) => item.url.endsWith('1-0'))).toBe(true)
    expect(diverse.results.some((item: any) => item.url.endsWith('2-0'))).toBe(false) // domain quota prevents monopoly
  })
})

describe('buildInternetQuestionPrompt', () => {
  test('MCQ/TF only, essay forbidden, evidence must be verbatim from a snippet', () => {
    const prompt = buildInternetQuestionPrompt({
      topic: 'مبادئ المحاسبة',
      programTitleAr: 'الماجستير المهني في إدارة الأعمال',
      count: 2,
      chunksSection: '[1] «عنوان» — https://example.com/x:\n' + SNIPPET_1,
      previousTexts: [],
    })
    expect(prompt).toContain('مبادئ المحاسبة')
    expect(prompt).toContain('صح/خطأ واختيار متعدد فقط')
    expect(prompt).toContain('ممنوع تماماً أي سؤال مقالي أو سؤال قصير')
    expect(prompt).toContain('اقتباساً حرفياً')
    expect(prompt).not.toContain('ESSAY')
  })

  test('comprehensive mode requires application and case analysis, still evidence-grounded', () => {
    const prompt = buildInternetQuestionPrompt({
      topic: 'القيادة التحويلية والتغيير التنظيمي',
      programTitleAr: 'الدكتوراه المهنية في إدارة الأعمال',
      programLevel: 'DOCTORATE',
      count: 10,
      comprehensive: true,
      chunksSection: SNIPPET_1,
      previousTexts: [],
    })
    expect(prompt).toContain('60% تحليل حالات متقدمة')
    expect(prompt).toContain('فلا تختلق واحدة')
    expect(prompt).toContain('المقاطع المختارة الوحيدة المسموح استخدامها كمصدر')
  })
})

describe('generateInternetQuestions', () => {
  test('independent verifier rejects a cited question whose answer is unsupported', async () => {
    const out = await generateInternetQuestions(
      RESULTS,
      { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      {
        completeJson: fakeComplete(GOOD_REPLY),
        verifyQuestions: (async ({ questions, examScope }: any) => {
          expect(examScope.specialty).toBe('الماجستير المهني في إدارة الأعمال')
          expect(examScope.topic).toBe('مبادئ المحاسبة')
          return questions.map((question: any, i: number) => ({
            ...question,
            qualityFlags: i === 0 ? [] : ['SOURCE_GROUNDED'],
            verifierReason: i === 0 ? 'VERIFIER_REJECTED' : undefined,
          }))
        }) as any,
      },
    )
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0].type).toBe('TF')
    expect(out.rejected[0].reason).toBe('VERIFIER_REJECTED')
  })

  test('does not save a degree-admissions question merely because its citation is literal', async () => {
    const academicReply = JSON.parse(GOOD_REPLY)
    academicReply[0].text = 'من هي الفئة المستهدفة للالتحاق ببرنامج دكتوراه إدارة الأعمال DBA؟'
    const out = await generateInternetQuestions(
      RESULTS,
      { topic: 'مبادئ المحاسبة', programTitleAr: 'الدكتوراه المهنية في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(JSON.stringify(academicReply)), verifyQuestions: fakeVerify },
    )
    expect(out.questions).toHaveLength(1)
    expect(out.questions[0].type).toBe('TF')
    expect(out.rejectedCount).toBe(1)
    expect(out.rejected[0]?.reason).toBe('DEGREE_ADMISSIONS_QUESTION')
  })

  test('preserves a model answer in the second option instead of shifting it to the first', async () => {
    const corrected = JSON.parse(GOOD_REPLY)
    corrected[0].options = ['المباني', 'النقدية', 'براءات الاختراع', 'الشهرة']
    corrected[0].correctAnswer = 'النقدية'
    const out = await generateInternetQuestions(
      RESULTS,
      { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(JSON.stringify(corrected)), verifyQuestions: fakeVerify },
    )
    expect(out.questions[0]?.correctAnswer).toBe('1')
  })

  test('accepts evidence-grounded MCQ/TF and attaches each snippet url', async () => {
    const out = await generateInternetQuestions(
      RESULTS,
      { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(GOOD_REPLY), verifyQuestions: fakeVerify },
    )
    expect(out.requested).toBe(2)
    expect(out.accepted).toBe(2)
    expect(out.questions.length).toBe(2)
    expect(out.questions[0].type).toBe('MCQ')
    expect(out.questions[0].correctAnswer).toBe('0')
    expect(out.questions[0].sourceEvidence).toBe(EVIDENCE_1)
    expect(out.questions[0].sourceUrl).toBe('https://example.com/assets')
    expect(out.questions[1].type).toBe('TF')
    expect(out.questions[1].sourceUrl).toBe('https://example.com/liabilities')
    expect(out.rejectedCount).toBe(0)
    expect(out.provider).toBe('GEMINI')
    expect(out.search).toEqual({ resultsFound: 2, chunksUsed: 2 })
  })

  test('a question with invented evidence is rejected, the rest survive', async () => {
    const badEvidence =
      'هذا نص مخترع لا يوجد في أي خلاصة من خلاصات البحث إطلاقاً وهو طويل بما يكفي ليتجاوز الحد الأدنى'
    const reply = JSON.stringify([
      JSON.parse(GOOD_REPLY)[0],
      {
        type: 'TF',
        text: 'النقدية ليست من الأصول المتداولة.',
        options: ['صح', 'خطأ'],
        correctAnswer: 'خطأ',
        sourceIndex: 1,
        sourceEvidence: badEvidence,
        difficulty: 'EASY',
        rationale: 'النقدية أصل متداول بلا شك.',
      },
    ])
    const out = await generateInternetQuestions(
      RESULTS,
      { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(reply), verifyQuestions: fakeVerify },
    )
    expect(out.accepted).toBe(1)
    expect(out.questions.length).toBe(1)
    expect(out.rejectedCount).toBe(1)
    expect(out.rejected[0].reason).toContain('NOT_FOUND')
  })

  test('a question duplicating an existing exam question is dropped, not saved twice', async () => {
    const out = await generateInternetQuestions(
      RESULTS,
      {
        topic: 'مبادئ المحاسبة',
        programTitleAr: 'الماجستير المهني في إدارة الأعمال',
        count: 2,
        previousQuestionTexts: ['أي مما يلي يُعد من الأصول المتداولة؟'],
      },
      { completeJson: fakeComplete(GOOD_REPLY), verifyQuestions: fakeVerify },
    )
    expect(out.accepted).toBe(1)
    expect(out.questions[0].type).toBe('TF')
    expect(out.rejected[0].reason).toBe('DUPLICATE_OF_EXISTING_QUESTION')
  })

  test('an all-invented batch fails outright — never a silent zero', async () => {
    const badEvidence =
      'هذا نص مخترع لا يوجد في أي خلاصة من خلاصات البحث إطلاقاً وهو طويل بما يكفي ليتجاوز الحد الأدنى'
    const reply = JSON.stringify([
      {
        type: 'TF',
        text: 'سؤال مخترع تماماً من خارج المصادر.',
        options: ['صح', 'خطأ'],
        correctAnswer: 'صح',
        sourceIndex: 1,
        sourceEvidence: badEvidence,
        difficulty: 'EASY',
        rationale: 'سبب مخترع للسؤال.',
      },
    ])
    const code = await expectCode(
      generateInternetQuestions(
        RESULTS,
        { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 1 },
        { completeJson: fakeComplete(reply), verifyQuestions: fakeVerify },
      ),
    )
    expect(code).toBe('VALIDATION_REJECTED')
  })

  test('an essay-typed draft is refused by the single gate — empty batch fails', async () => {
    const reply = JSON.stringify([
      {
        type: 'ESSAY',
        text: 'اشرح الأصول المتداولة بالتفصيل مع ذكر أمثلة.',
        sourceIndex: 1,
        sourceEvidence: EVIDENCE_1,
        difficulty: 'MEDIUM',
        rationale: 'سؤال مقالي مرفوض.',
        modelAnswer: 'مرجع التصحيح: الأصول المتداولة.',
        points: 10,
      },
    ])
    const code = await expectCode(
      generateInternetQuestions(
        RESULTS,
        { topic: 'مبادئ المحاسبة', programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 1 },
        { completeJson: fakeComplete(reply), verifyQuestions: fakeVerify },
      ),
    )
    expect(code).toBe('INSUFFICIENT_SOURCE')
  })

  test('zero results and all-short snippets fail as insufficient source', async () => {
    expect(
      await expectCode(
        generateInternetQuestions([], { topic: 'موضوع بلا نتائج', programTitleAr: 'برنامج', count: 5 }),
      ),
    ).toBe('INSUFFICIENT_SOURCE')
    expect(
      await expectCode(
        generateInternetQuestions(
          [{ title: 'قصير', url: 'https://example.com/s', content: 'نص قصير.' }],
          { topic: 'موضوع', programTitleAr: 'برنامج', count: 5 },
        ),
      ),
    ).toBe('INSUFFICIENT_SOURCE')
  })
})
