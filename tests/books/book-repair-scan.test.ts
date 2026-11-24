import { mock, describe, expect, it } from 'bun:test'

// The scan module reuses the book analyzer + knowledge bank, which pull the
// Prisma client at import time, and the sandbox has no generated client, so
// the database module is mocked here; the functions under test never touch
// the database.
mock.module('@/lib/db', () => ({ db: {} }))

const scan = await import('@/lib/book-repair-scan')
const {
  scanBookDistortion,
  correctKnowledgeItemFromSource,
  buildKeyTermForItem,
  buildSectionSummaryForItem,
  replaceQuotedExcerpt,
} = scan
const { planKnowledgeItemCleanup, looksLikeBrokenGeneratedArabic, cleanAcademicOutput } =
  await import('@/lib/academic-output-quality')
const { looksLikeBrokenAcademicOutput, looksLikeBrokenExcerpt } =
  await import('@/lib/knowledge-bank')
const { buildUnitStudyGuideDraft } = await import('@/lib/outline-units')

const cleanArabic =
  'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(40)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const garbledExcerpt = '□ '.repeat(60)

const cleanTitle = 'مفهوم الأصول المتداولة في المحاسبة المالية'
const cleanSummary =
  'الأصول المتداولة هي الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية وتظهر في القوائم المالية'
const cleanExcerpt =
  'تعد الأصول المتداولة من أهم عناصر القوائم المالية في المحاسبة الحديثة وتشمل النقدية والذمم المدينة والمخزون'
// A fragment no cleaning rule repairs: the item is broken in exactly one field.
const brokenFragment = 'في كتاب احرب عند الاستراتيجيين'
const titleOnlyBroken = 'كتاب احرب في الفكر الاستراتيجي العسكري'

// Best verbatim span for the excerpt tests: it restates the item's concepts
// (coverage 0.94), while the distractors stay under the 0.5 floor.
// Note: sentence splitting drops the final '.', so the span the function
// returns is the sentence without its terminator.
const targetSentence =
  'الأصول المتداولة هي الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية وتظهر في القوائم المالية في المحاسبة المالية'
const targetSpan = `${targetSentence}.`
const distractorSpan =
  'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية الحديثة.'
const otherSpan =
  'تعتمد المنشأة على القوائم المالية لعرض نتائج أعمالها أمام الإدارة والمستثمرين.'
const correctedWithSpan = `${distractorSpan} ${targetSpan} ${otherSpan}`

const philosophySource =
  'يتحدث هذا الفصل عن تاريخ الفلسفة اليونانية وأثرها في الفكر الأوروبي الحديث والمعاصر. ' +
  'يشرح الكاتب نشأة المدارس الفلسفية الأولى ودورها في تشكيل العقل النقدي عبر القرون.'

function planAction(data: { title: string; summary: string; excerpt: string | null }) {
  return planKnowledgeItemCleanup(data, looksLikeBrokenAcademicOutput, looksLikeBrokenExcerpt)
    .action
}

describe('scanBookDistortion', () => {
  const chunks = [
    { id: 'c-clean', index: 0, text: cleanArabic },
    { id: 'c-garbled', index: 1, text: garbledPage },
    { id: 'c-empty', index: 2, text: '' },
    { id: 'c-blank', index: 3, text: '   ' },
  ]
  const items = [
    { id: 'i-clean', chunkId: 'c-clean', title: cleanTitle, summary: cleanSummary, excerpt: cleanExcerpt },
    { id: 'i-title', chunkId: 'c-clean', title: titleOnlyBroken, summary: cleanSummary, excerpt: cleanExcerpt },
    { id: 'i-summary', chunkId: 'c-clean', title: cleanTitle, summary: `${cleanSummary} ${brokenFragment}`, excerpt: cleanExcerpt },
    { id: 'i-excerpt', chunkId: 'c-garbled', title: cleanTitle, summary: cleanSummary, excerpt: garbledExcerpt },
    { id: 'i-empty', chunkId: 'c-empty', title: '', summary: '', excerpt: '' },
  ]

  it('detects a garbled chunk and leaves clean, empty and blank chunks healthy', () => {
    const result = scanBookDistortion(chunks, items)
    expect(result.distortedChunkIds).toEqual(['c-garbled'])
    expect(result.healthyChunks).toBe(3)
  })

  it('detects an item broken in title only, in summary only, in excerpt only', () => {
    const result = scanBookDistortion(chunks, items)
    expect(result.distortedItemIds).toEqual(['i-title', 'i-summary', 'i-excerpt'])
    // The all-empty item is DELETE_EMPTY in the review-queue plan, not
    // REVIEW, so it is not distortion; the clean item is healthy.
    expect(result.healthyItems).toBe(2)
  })

  it('marks a clean chunk and a clean item healthy', () => {
    const result = scanBookDistortion(
      [{ id: 'c1', index: 0, text: cleanArabic }],
      [{ id: 'i1', chunkId: 'c1', title: cleanTitle, summary: cleanSummary, excerpt: cleanExcerpt }],
    )
    expect(result).toEqual({
      distortedChunkIds: [],
      distortedItemIds: [],
      healthyChunks: 1,
      healthyItems: 1,
    })
  })
})

describe('correctKnowledgeItemFromSource', () => {
  it('replaces a garbled excerpt with the best verbatim span from the corrected text', () => {
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: cleanSummary, excerpt: garbledExcerpt, pageStart: 3, pageEnd: 3 },
      correctedWithSpan,
    )
    expect(result.status).toBe('CORRECTED')
    if (result.status !== 'CORRECTED') return
    expect(result.data.title).toBe(cleanTitle)
    expect(result.data.summary).toBe(cleanSummary)
    expect(result.data.excerpt).toBe(targetSentence)
  })

  it('keeps a healthy excerpt that is verbatim in the corrected text', () => {
    const source = `${cleanExcerpt}. ${targetSpan}`
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: cleanSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      source,
    )
    expect(result.status).toBe('CORRECTED')
    if (result.status !== 'CORRECTED') return
    expect(result.data.excerpt).toBe(cleanExcerpt)
  })

  it('skips a garbled high-overlap span and takes the clean verbatim span', () => {
    // The garbled span shares the same tokens as the clean target (coverage
    // 0.94) and comes first, so without the garble filter it would win the
    // tie; the filter must skip it.
    const garbledTarget = `${'□ '.repeat(12)}${targetSentence}.`
    const source = `${garbledTarget} ${targetSpan} ${distractorSpan}`
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: cleanSummary, excerpt: garbledExcerpt, pageStart: 3, pageEnd: 3 },
      source,
    )
    expect(result.status).toBe('CORRECTED')
    if (result.status !== 'CORRECTED') return
    expect(result.data.excerpt).toBe(targetSentence)
    expect(result.data.excerpt.includes('□')).toBe(false)
  })

  it('returns REVIEW when no span supports the excerpt', () => {
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: cleanSummary, excerpt: garbledExcerpt, pageStart: 3, pageEnd: 3 },
      philosophySource,
    )
    expect(result).toEqual({ status: 'REVIEW', reason: 'EXCERPT_NO_SUPPORTING_SPAN' })
  })

  it('returns REVIEW when the title cannot be repaired by the cleaning rules', () => {
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: titleOnlyBroken, summary: cleanSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      correctedWithSpan,
    )
    expect(result).toEqual({ status: 'REVIEW', reason: 'TITLE_UNPROVABLE' })
  })
})

describe('correctKnowledgeItemFromSource — rule repair', () => {
  // The broken-field detectors clean the text before judging it, so a
  // rule-repairable break is only visible when the garble sits past
  // cleanAcademicOutput's 1800-char default cap: the detector (cap 5000)
  // still sees it, while the candidate (cap 1800) drops it. The fixture
  // below proves exactly that: a long clean block cut at a word boundary,
  // then unrepairable garble past the cap.
  const SENT = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '
  function longBrokenField(): string {
    const block = SENT.repeat(30)
    const cutAt = block.lastIndexOf(' ', 1800)
    // Clean prefix of exactly 1800 chars ending on the complete word
    // 'تتناول' (a token the corrected source contains), then garble: the
    // detector (cap 5000) sees it, while the candidate (cap 1800) is
    // exactly the clean prefix — no word cut in half, no trailing space,
    // so the repaired field is stable under the review-queue plan.
    return `${block.slice(0, cutAt)} تتناول في كتاب احرب عند الاستراتيجيين`
  }
  const longBrokenTitle = longBrokenField()
  const titleSource = `${SENT.repeat(3)}${cleanExcerpt}.`

  it('repairs a broken title by the cleaning rules + token proof', () => {
    expect(looksLikeBrokenGeneratedArabic(longBrokenTitle)).toBe(true)
    const candidate = cleanAcademicOutput(longBrokenTitle)
    expect(candidate.endsWith('تتناول')).toBe(true)
    expect(candidate.length).toBe(1800)
    expect(looksLikeBrokenGeneratedArabic(candidate)).toBe(false)
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: longBrokenTitle, summary: cleanSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      titleSource,
    )
    expect(result.status).toBe('CORRECTED')
    if (result.status !== 'CORRECTED') return
    expect(result.data.title).toBe(candidate)
    expect(result.data.summary).toBe(cleanSummary)
    expect(result.data.excerpt).toBe(cleanExcerpt)
  })

  it('repairs a broken summary the same way', () => {
    const longBrokenSummary = longBrokenField()
    expect(looksLikeBrokenGeneratedArabic(longBrokenSummary)).toBe(true)
    expect(looksLikeBrokenGeneratedArabic(cleanAcademicOutput(longBrokenSummary))).toBe(false)
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: longBrokenSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      titleSource,
    )
    expect(result.status).toBe('CORRECTED')
    if (result.status !== 'CORRECTED') return
    expect(result.data.summary).toBe(cleanAcademicOutput(longBrokenSummary))
    expect(result.data.title).toBe(cleanTitle)
  })

  it('returns REVIEW when the repaired title tokens are absent from the source', () => {
    const result = correctKnowledgeItemFromSource(
      { id: 'i1', title: longBrokenTitle, summary: cleanSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      philosophySource,
    )
    expect(result).toEqual({ status: 'REVIEW', reason: 'TITLE_UNPROVABLE' })
  })

  it('CORRECTED data passes the review-queue plan (action KEEP)', () => {
    const fixedExcerpt = correctKnowledgeItemFromSource(
      { id: 'i1', title: cleanTitle, summary: cleanSummary, excerpt: garbledExcerpt, pageStart: 3, pageEnd: 3 },
      correctedWithSpan,
    )
    const fixedTitle = correctKnowledgeItemFromSource(
      { id: 'i1', title: longBrokenTitle, summary: cleanSummary, excerpt: cleanExcerpt, pageStart: 3, pageEnd: 3 },
      titleSource,
    )
    expect(fixedExcerpt.status).toBe('CORRECTED')
    expect(fixedTitle.status).toBe('CORRECTED')
    if (fixedExcerpt.status === 'CORRECTED') expect(planAction(fixedExcerpt.data)).toBe('KEEP')
    if (fixedTitle.status === 'CORRECTED') expect(planAction(fixedTitle.data)).toBe('KEEP')
  })
})

describe('guide rebuild formulas', () => {
  const item = { title: cleanTitle, summary: cleanSummary, excerpt: targetSpan, pageStart: 3, pageEnd: 5 }
  const firstSentenceOfTarget =
    'الأصول المتداولة هي الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية وتظهر في القوائم المالية في المحاسبة المالية'

  it('buildKeyTermForItem matches the guide keyTerm formula exactly', () => {
    const expected = `${cleanTitle}: ${firstSentenceOfTarget} (صفحات 3–5)`
    expect(buildKeyTermForItem(item)).toBe(expected)
    // Same value the real guide builder produces for this item.
    const draft = buildUnitStudyGuideDraft({
      programTitle: 'برنامج المحاسبة',
      unitTitle: 'وحدة الأصول',
      semester: 1,
      knowledge: [{ id: 'k1', category: 'CONCEPT', ...item }],
    })
    expect(draft.keyTerms[0]).toBe(expected)
  })

  it('buildSectionSummaryForItem matches the guide section-summary formula exactly', () => {
    const expected = `${cleanSummary} — مرجع الصفحات: صفحات 3–5.`
    expect(buildSectionSummaryForItem(item)).toBe(expected)
    const draft = buildUnitStudyGuideDraft({
      programTitle: 'برنامج المحاسبة',
      unitTitle: 'وحدة الأصول',
      semester: 1,
      knowledge: [{ id: 'k1', category: 'CONCEPT', ...item }],
    })
    expect(draft.sections[0].summary).toBe(expected)
  })

  it('omits the page reference when pages are unknown, and uses the singular for one page', () => {
    expect(buildKeyTermForItem({ ...item, pageStart: undefined, pageEnd: undefined })).toBe(
      `${cleanTitle}: ${firstSentenceOfTarget}`,
    )
    expect(buildSectionSummaryForItem({ ...item, pageStart: undefined, pageEnd: undefined })).toBe(
      cleanSummary,
    )
    expect(buildKeyTermForItem({ ...item, pageStart: 4, pageEnd: 4 })).toBe(
      `${cleanTitle}: ${firstSentenceOfTarget} (صفحة 4)`,
    )
    expect(buildSectionSummaryForItem({ ...item, pageStart: 4, pageEnd: 4 })).toBe(
      `${cleanSummary} — مرجع الصفحات: صفحة 4.`,
    )
  })
})

describe('replaceQuotedExcerpt', () => {
  const newExcerpt =
    'الأصول المتداولة تشمل النقدية والذمم المدينة والمخزون وتظهر في القوائم المالية.'

  it('replaces only the quoted span and leaves the rest byte-identical', () => {
    const text = `راجع ذاتياً: كيف تشرح «${targetSpan}» اعتماداً على المصدر؟`
    const result = replaceQuotedExcerpt(text, targetSpan, newExcerpt)
    expect(result.replaced).toBe(true)
    expect(result.text).toBe(`راجع ذاتياً: كيف تشرح «${newExcerpt}» اعتماداً على المصدر؟`)
  })

  it('replaces only the first occurrence when the quote appears twice', () => {
    const text = `«${targetSpan}» ثم «${targetSpan}»`
    const result = replaceQuotedExcerpt(text, targetSpan, newExcerpt)
    expect(result.replaced).toBe(true)
    expect(result.text).toBe(`«${newExcerpt}» ثم «${targetSpan}»`)
  })

  it('falls back to the first sentence when the guide quoted only that', () => {
    const oldFirst =
      'الجملة الأولى من المقتطف القديم تشرح مفهوم الأصول المتداولة وكيفية قياسها بدقة'
    const oldTwo = `${oldFirst}. والجملة الثانية تكمل المعنى بشرح إضافي عن القوائم المالية.`
    const newFirst =
      'الجملة الأولى من المقتطف الجديد توضح مفهوم الأصول المتداولة وطرق قياسها في القوائم'
    const newTwo = `${newFirst}. والجملة الثانية تضيف تفصيلاً عن المخزون والذمم المدينة.`
    expect(oldFirst.length).toBeGreaterThanOrEqual(60)
    expect(newFirst.length).toBeGreaterThanOrEqual(60)
    const text = `المصطلح: ${oldFirst} (صفحات 3–5)`
    expect(text.includes(oldTwo)).toBe(false)
    const result = replaceQuotedExcerpt(text, oldTwo, newTwo)
    expect(result.replaced).toBe(true)
    expect(result.text).toBe(`المصطلح: ${newFirst} (صفحات 3–5)`)
  })

  it('returns replaced: false and the text unchanged when no quote is present', () => {
    const text = 'نص لا يحتوي على أي اقتباس من المقتطف القديم إطلاقاً.'
    const result = replaceQuotedExcerpt(text, targetSpan, newExcerpt)
    expect(result).toEqual({ text, replaced: false })
    expect(result.text).toBe(text)
  })
})
