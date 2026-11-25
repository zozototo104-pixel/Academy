// Comprehensive exam — custom-book source: pure helpers, extraction
// reporting, and generation against a fake model reply.
// The DB is mocked (the lib's import chain pulls @/lib/db through
// book-reader/gemini); extraction and AI completion are injected, so
// no real PDF text layer or model call is needed here.
import { describe, expect, mock, test } from 'bun:test'
import { PDFDocument } from 'pdf-lib'

mock.module('@/lib/db', () => ({ db: {} }))

const lib = await import('../../src/lib/comprehensive-exam-custom-book')
const {
  buildCustomBookQuestionPrompt,
  clampCustomBookQuestionCount,
  countRawQuestionItems,
  customBookChunksToExamChunks,
  customBookFileName,
  customBookSourceId,
  extractCustomBookChunks,
  formatCustomBookChunksForPrompt,
  generateCustomBookQuestions,
  splitDocxTextIntoPseudoPages,
} = lib

const CHUNK_1_TEXT =
  'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد أو استهلاكها خلال دورة التشغيل العادية أو خلال سنة مالية واحدة أيهما أطول، وتشمل النقدية وما في حكمها والحسابات المدينة والمخزون والمصروفات المدفوعة مقدماً.'
const CHUNK_2_TEXT =
  'الالتزامات المتداولة هي الالتزامات التي تستحق السداد خلال دورة التشغيل العادية أو خلال سنة مالية واحدة، وتشمل الحسابات الدائنة وأوراق الدفع قصيرة الأجل والمصروفات المستحقة والجزء المتداول من القروض طويلة الأجل.'
const EVIDENCE_1 =
  'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد أو استهلاكها خلال دورة التشغيل العادية'
const EVIDENCE_2 =
  'الالتزامات المتداولة هي الالتزامات التي تستحق السداد خلال دورة التشغيل العادية أو خلال سنة مالية واحدة'
const GARBLED_TEXT = 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(4)

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

function extractionOf() {
  return {
    bookId: 'custom-upload:testbook00000001',
    bookTitle: 'مبادئ المحاسبة',
    totalPages: 4,
    readablePages: 4,
    unreadablePages: [],
    chunks: [
      { sourceIndex: 1, bookId: 'custom-upload:testbook00000001', bookTitle: 'مبادئ المحاسبة', text: CHUNK_1_TEXT, textProvenance: 'NATIVE_TEXT' as const, pageStart: 1, pageEnd: 2 },
      { sourceIndex: 2, bookId: 'custom-upload:testbook00000001', bookTitle: 'مبادئ المحاسبة', text: CHUNK_2_TEXT, textProvenance: 'NATIVE_TEXT' as const, pageStart: 3, pageEnd: 4 },
    ],
  }
}

function fakeComplete(reply: string) {
  return async ({ validate }: any) => {
    validate(reply, { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })
    return { text: reply, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }
  }
}

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([595, 842])
  return Buffer.from(await doc.save())
}

describe('clampCustomBookQuestionCount', () => {
  test('clamps into 1..10 and defaults on garbage', () => {
    expect(clampCustomBookQuestionCount(0)).toBe(1)
    expect(clampCustomBookQuestionCount(11)).toBe(10)
    expect(clampCustomBookQuestionCount('7')).toBe(7)
    expect(clampCustomBookQuestionCount(5.9)).toBe(5)
    expect(clampCustomBookQuestionCount(NaN)).toBe(5)
    expect(clampCustomBookQuestionCount(undefined)).toBe(5)
  })
})

describe('customBookSourceId / customBookFileName', () => {
  test('content-addressed synthetic id, never a real book id', () => {
    const a = customBookSourceId(Buffer.from('book-a'))
    const b = customBookSourceId(Buffer.from('book-a'))
    const c = customBookSourceId(Buffer.from('book-b'))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('custom-upload:')).toBe(true)
  })
  test('file name without extension, fallback for empty', () => {
    expect(customBookFileName('مبادئ المحاسبة.pdf')).toBe('مبادئ المحاسبة')
    expect(customBookFileName('')).toBe('كتاب مخصص')
  })
})

describe('customBookChunksToExamChunks / formatCustomBookChunksForPrompt', () => {
  test('indexes from 1 and keeps page ranges for the locator', () => {
    const chunks = customBookChunksToExamChunks(
      [
        { index: 0, pageStart: 1, pageEnd: 2, text: CHUNK_1_TEXT, textProvenance: 'NATIVE_TEXT' as const },
        { index: 1, pageStart: 3, pageEnd: 4, text: CHUNK_2_TEXT, textProvenance: 'NATIVE_TEXT' as const },
      ],
      'custom-upload:x',
      'مبادئ المحاسبة',
    )
    expect(chunks.map((c: any) => c.sourceIndex)).toEqual([1, 2])
    expect(chunks[0].pageStart).toBe(1)
    expect(chunks[1].pageEnd).toBe(4)
    const section = formatCustomBookChunksForPrompt(chunks)
    expect(section).toContain('[1] صفحات 1–2 من «مبادئ المحاسبة»:')
    expect(section).toContain(CHUNK_1_TEXT)
  })
})

describe('countRawQuestionItems', () => {
  test('counts a bare array and an array wrapped in prose', () => {
    expect(countRawQuestionItems(GOOD_REPLY)).toBe(2)
    expect(countRawQuestionItems(`إليك الأسئلة:\n${GOOD_REPLY}\nانتهى`)).toBe(2)
    expect(countRawQuestionItems('لا يوجد JSON هنا')).toBe(0)
  })
})

describe('buildCustomBookQuestionPrompt', () => {
  test('asks MCQ/TF only — no essay or short type anywhere', () => {
    const prompt = buildCustomBookQuestionPrompt({
      bookTitle: 'مبادئ المحاسبة',
      programTitleAr: 'الماجستير المهني في إدارة الأعمال',
      count: 5,
      chunksSection: '[1] صفحات 1–2 من «مبادئ المحاسبة»:\n' + CHUNK_1_TEXT,
      previousTexts: [],
    })
    expect(prompt).toContain('"type":"MCQ"')
    expect(prompt).toContain('"type":"TF"')
    expect(prompt.includes('ESSAY')).toBe(false)
    expect(prompt.includes('SHORT')).toBe(false)
    expect(prompt).toContain('مبادئ المحاسبة')
    expect(prompt).toContain('5')
  })
})

describe('extractCustomBookChunks', () => {
  test('reports unreadable pages honestly and chunks only readable text', async () => {
    const pdf = await makePdf(3)
    const extractPages = async (_buffer: Buffer, numbers: readonly number[]) =>
      numbers.map((page) => ({
        page,
        text: page === 1 ? CHUNK_1_TEXT : page === 2 ? '' : GARBLED_TEXT,
        textProvenance: 'NATIVE_TEXT' as const,
      }))
    const out = await extractCustomBookChunks(pdf, 'مبادئ المحاسبة.pdf', { extractPages })
    expect(out.totalPages).toBe(3)
    expect(out.readablePages).toBe(1)
    expect(out.unreadablePages).toEqual([
      { page: 2, reason: 'NO_EXTRACTABLE_TEXT' },
      { page: 3, reason: 'BOOK_PAGE_TEXT_FAILED_QUALITY_GATE' },
    ])
    expect(out.chunks.length).toBe(1)
    expect(out.chunks[0].text).toBe(CHUNK_1_TEXT)
    expect(out.chunks[0].pageStart).toBe(1)
    expect(out.bookId.startsWith('custom-upload:')).toBe(true)
    expect(out.bookTitle).toBe('مبادئ المحاسبة')
  })

  test('a non-PDF buffer fails as not-a-PDF, never as zero questions', async () => {
    await expect(extractCustomBookChunks(Buffer.from('not a pdf at all'), 'x.pdf')).rejects.toThrow('CUSTOM_BOOK_NOT_A_PDF')
  })

  test('a book longer than the cap fails outright', async () => {
    const pdf = await makePdf(301)
    await expect(extractCustomBookChunks(pdf, 'long.pdf', { extractPages: async () => [] })).rejects.toThrow('CUSTOM_BOOK_TOO_LONG')
  })
})

describe('generateCustomBookQuestions', () => {
  test('accepts evidence-grounded MCQ/TF and maps them through the single gate', async () => {
    const out = await generateCustomBookQuestions(
      extractionOf(),
      { programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(GOOD_REPLY) },
    )
    expect(out.requested).toBe(2)
    expect(out.accepted).toBe(2)
    expect(out.questions.length).toBe(2)
    expect(out.questions[0].type).toBe('MCQ')
    expect(out.questions[0].options).toEqual(['النقدية', 'المباني', 'براءات الاختراع', 'الشهرة'])
    expect(out.questions[0].correctAnswer).toBe('0')
    expect(out.questions[0].sourceEvidence).toBe(EVIDENCE_1)
    expect(out.questions[1].type).toBe('TF')
    expect(out.questions[1].options).toEqual(['صح', 'خطأ'])
    expect(out.questions[1].correctAnswer).toBe('0')
    expect(out.rejectedCount).toBe(0)
    expect(out.provider).toBe('GEMINI')
  })

  test('a question with invented evidence is rejected, the rest survive', async () => {
    const badEvidence =
      'هذا نص مخترع لا يوجد في أي مقطع من مقاطع الكتاب المرفوع إطلاقاً وهو طويل بما يكفي ليتجاوز الحد الأدنى'
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
    const out = await generateCustomBookQuestions(
      extractionOf(),
      { programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: fakeComplete(reply) },
    )
    expect(out.accepted).toBe(1)
    expect(out.questions.length).toBe(1)
    expect(out.rejectedCount).toBe(1)
    expect(out.rejected[0].reason).toContain('NOT_FOUND')
  })

  test('a question duplicating an existing exam question is dropped, not saved twice', async () => {
    const out = await generateCustomBookQuestions(
      extractionOf(),
      {
        programTitleAr: 'الماجستير المهني في إدارة الأعمال',
        count: 2,
        previousQuestionTexts: ['أي مما يلي يُعد من الأصول المتداولة؟'],
      },
      { completeJson: fakeComplete(GOOD_REPLY) },
    )
    expect(out.accepted).toBe(1)
    expect(out.questions[0].type).toBe('TF')
    expect(out.rejected[0].reason).toBe('DUPLICATE_OF_EXISTING_QUESTION')
  })

  test('an all-invented batch fails outright — never a silent zero', async () => {
    const badEvidence =
      'هذا نص مخترع لا يوجد في أي مقطع من مقاطع الكتاب المرفوع إطلاقاً وهو طويل بما يكفي ليتجاوز الحد الأدنى'
    const reply = JSON.stringify([
      {
        type: 'TF',
        text: 'سؤال مخترع تماماً من خارج الكتاب.',
        options: ['صح', 'خطأ'],
        correctAnswer: 'صح',
        sourceIndex: 1,
        sourceEvidence: badEvidence,
        difficulty: 'EASY',
        rationale: 'سبب مخترع للسؤال.',
      },
    ])
    let code = ''
    try {
      await generateCustomBookQuestions(
        extractionOf(),
        { programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 1 },
        { completeJson: fakeComplete(reply) },
      )
    } catch (e: any) {
      code = e?.code || ''
    }
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
    // The evidence schema itself accepts ESSAY, so the batch survives
    // evidence validation — but the single comprehensive gate (MCQ/TF
    // only) refuses it, leaving zero savable questions, which fails
    // outright as insufficient source rather than saving nothing.
    let code = ''
    try {
      await generateCustomBookQuestions(
        extractionOf(),
        { programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 1 },
        { completeJson: fakeComplete(reply) },
      )
    } catch (e: any) {
      code = e?.code || ''
    }
    expect(code).toBe('INSUFFICIENT_SOURCE')
  })
})

describe('splitDocxTextIntoPseudoPages', () => {
  test('short text is one pseudo-page; paragraphs accumulate to the page size', () => {
    expect(splitDocxTextIntoPseudoPages(CHUNK_1_TEXT)).toHaveLength(1)
    const para = 'فقرة نصية طويلة بما يكفي لقياس التقسيم. '.repeat(20).trim() // ~800 chars
    expect(para.length).toBeGreaterThan(700)
    const pages = splitDocxTextIntoPseudoPages([para, para, para].join('\n\n'))
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain(para.slice(0, 40))
    expect(pages.every((p: string) => p.length <= 2000)).toBe(true)
  })

  test('a single over-long paragraph splits at word boundaries', () => {
    const long = Array.from({ length: 450 }, () => 'كلمة').join(' ') // ~2250 chars
    const pages = splitDocxTextIntoPseudoPages(long)
    expect(pages.length).toBe(2)
    expect(pages.every((p: string) => p.length <= 2000)).toBe(true)
    expect(pages.join(' ').replace(/\s+/g, ' ')).toContain('كلمة كلمة كلمة')
  })

  test('empty text has no pseudo-pages', () => {
    expect(splitDocxTextIntoPseudoPages('')).toEqual([])
    expect(splitDocxTextIntoPseudoPages('   \n\n  ')).toEqual([])
  })
})

describe('extractCustomBookChunks — DOCX', () => {
  const DOCX_TEXT = CHUNK_1_TEXT + '\n\n' + CHUNK_2_TEXT
  const fakeDocx = (text: string, readable = true, reader: any = 'DOCX') => async () => ({ text, readable, reader, note: '' })

  test('reads a .docx into pseudo-pages with kind DOCX and the same chunking', async () => {
    const out = await extractCustomBookChunks(Buffer.from('fake-docx-bytes'), 'مبادئ المحاسبة.docx', {
      extractDocumentText: fakeDocx(DOCX_TEXT),
    })
    expect(out.kind).toBe('DOCX')
    expect(out.totalPages).toBe(1)
    expect(out.readablePages).toBe(1)
    expect(out.unreadablePages).toEqual([])
    expect(out.chunks.length).toBe(1)
    expect(out.chunks[0].pageStart).toBe(1)
    expect(out.chunks[0].pageEnd).toBe(1)
    expect(out.chunks[0].text).toContain('الأصول المتداولة')
    expect(out.bookTitle).toBe('مبادئ المحاسبة')
  })

  test('PDF extraction still reports kind PDF', async () => {
    const pdf = await makePdf(1)
    const out = await extractCustomBookChunks(pdf, 'book.pdf', {
      extractPages: async (_buffer: Buffer, numbers: readonly number[]) =>
        numbers.map((page) => ({ page, text: CHUNK_1_TEXT, textProvenance: 'NATIVE_TEXT' as const })),
    })
    expect(out.kind).toBe('PDF')
    expect(out.totalPages).toBe(1)
  })

  test('a .docx with no readable text reports zero pages and zero chunks', async () => {
    const out = await extractCustomBookChunks(Buffer.from('empty-docx'), 'فارغ.docx', {
      extractDocumentText: fakeDocx('', false, 'EMPTY'),
    })
    expect(out.kind).toBe('DOCX')
    expect(out.totalPages).toBe(0)
    expect(out.readablePages).toBe(0)
    expect(out.chunks).toEqual([])
  })

  test('a corrupt .docx fails as unreadable, never as zero questions', async () => {
    await expect(
      extractCustomBookChunks(Buffer.from('corrupt'), 'تالف.docx', { extractDocumentText: fakeDocx('', false, 'ERROR') }),
    ).rejects.toThrow('CUSTOM_BOOK_DOCX_UNREADABLE')
  })

  test('a garbled pseudo-page is reported unreadable, not chunked', async () => {
    const out = await extractCustomBookChunks(Buffer.from('garbled'), 'مشوه.docx', {
      extractDocumentText: fakeDocx(GARBLED_TEXT),
    })
    expect(out.kind).toBe('DOCX')
    expect(out.chunks).toEqual([])
    expect(out.unreadablePages).toEqual([{ page: 1, reason: 'BOOK_PAGE_TEXT_FAILED_QUALITY_GATE' }])
  })

  test('a .docx longer than 300 pseudo-pages fails outright', async () => {
    const longText = Array.from({ length: 301 }, () => 'و'.repeat(2000)).join('\n\n')
    await expect(
      extractCustomBookChunks(Buffer.from('long-docx'), 'طويل.docx', { extractDocumentText: fakeDocx(longText) }),
    ).rejects.toThrow('CUSTOM_BOOK_TOO_LONG')
  })

  test('generation from a DOCX extraction labels the locator as text blocks, not pages', async () => {
    let capturedPrompt = ''
    const captureComplete = async ({ validate, prompt }: any) => {
      capturedPrompt = prompt
      validate(GOOD_REPLY, { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })
      return { text: GOOD_REPLY, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }
    }
    const out = await generateCustomBookQuestions(
      { ...extractionOf(), kind: 'DOCX' },
      { programTitleAr: 'الماجستير المهني في إدارة الأعمال', count: 2 },
      { completeJson: captureComplete },
    )
    expect(out.accepted).toBe(2)
    expect(capturedPrompt).toContain('مقاطع نصية 1–2')
    expect(capturedPrompt).not.toContain('صفحات 1–2')
  })
})
