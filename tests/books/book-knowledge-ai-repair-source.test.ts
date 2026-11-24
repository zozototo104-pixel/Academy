import { describe, expect, mock, test } from 'bun:test'

// Pure helpers of the AI knowledge repair: source-window location (no
// verbatim match of the garbled excerpt required) and candidate acceptance.
// The scheduler imports the Prisma client (not generated in this sandbox)
// via @/lib/db, so stub the DB and the OCR/storage modules it loads before
// importing it. Nothing under test touches the database.
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/book-reader', () => ({ transcribeScannedDocumentWithVision: async () => [] }))
mock.module('@/lib/storage', () => ({ getFileBufferFromStorageOrBase64: async () => null }))

const { repairSourceWindow, assessRepairCandidate } = await import('../../src/lib/book-knowledge-v2-scheduler')

const S1 = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة واتخاذ القرارات.'
const S2 = 'تعرف الأصول المتداولة بأنها الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية.'
const S3 = 'يقيس قائمة المركز المالي حقوق الملكية بعد خصم الالتزامات من إجمالي الأصول في تاريخ محدد.'
const S4 = 'تعتمد القوائم المالية على مبدأ الاستحقاق في إثبات الإيرادات والمصروفات عند تحققها.'
const S5 = 'يركز التسويق الحديث على فهم احتياجات العملاء وبناء علاقات طويلة الأمد معهم.'
const S6 = 'تدرس بحوث التسويق سلوك المستهلك لتحديد الشرائح المستهدفة وتصميم المنتجات المناسبة لها.'
const S7 = 'يقسم التسويق السوق إلى شرائح وفق خصائص العملاء وسلوك الشراء لديهم.'
const S8 = 'تعتمد الحملات التسويقية على رسائل واضحة تصل إلى الشرائح المستهدفة عبر القنوات المناسبة.'

// Region A (accounting, ~3000 chars) then region B (marketing, ~3000).
// The item's concepts live in region B; its excerpt is garbled.
const regionA = [S1, S2, S3, S4].map((s) => `${s} `.repeat(12)).join(' ')
const regionB = [S5, S6, S7, S8].map((s) => `${s} `.repeat(12)).join(' ')
const bigChunk = `${regionA} ${regionB}`
const marketingItem = {
  title: 'سلوك المستهلك والشرائح المستهدفة في التسويق الحديث',
  summary: `${S5} ${S6}`,
  excerpt: `${'□ '.repeat(40)}سلوك المستهلك في الشرائح المستهدفة.`,
}

describe('repairSourceWindow', () => {
  test('a small healthy chunk needs no anchor: the whole chunk is the evidence', () => {
    const chunk = `${S1} ${S2} ${S3} ${S4}`
    const result = repairSourceWindow(chunk, { title: 'عنوان', summary: S2, excerpt: null })
    expect(result.status).toBe('OK')
    if (result.status !== 'OK') throw new Error('expected OK')
    expect(result.evidence).toContain(S2)
  })

  test('a linked chunk with a garbled excerpt still gets a source window (concept match)', () => {
    expect(bigChunk.length).toBeGreaterThan(4800)
    const result = repairSourceWindow(bigChunk, marketingItem)
    expect(result.status).toBe('OK')
    if (result.status !== 'OK') throw new Error('expected OK')
    // The window is the item's own region (marketing), not the first page.
    expect(result.evidence).toContain(S6)
    expect(result.evidence).toContain(S5)
    expect(result.evidence).not.toContain(S1)
    expect(result.evidence.length).toBeLessThanOrEqual(4800)
  })

  test('a null excerpt on a large chunk still locates via title/summary concepts', () => {
    const result = repairSourceWindow(bigChunk, { title: marketingItem.title, summary: marketingItem.summary, excerpt: null })
    expect(result.status).toBe('OK')
    if (result.status !== 'OK') throw new Error('expected OK')
    expect(result.evidence).toContain(S6)
  })

  test('an intact excerpt anchor still wins on a large chunk', () => {
    const result = repairSourceWindow(bigChunk, {
      title: marketingItem.title,
      summary: marketingItem.summary,
      excerpt: S6,
    })
    expect(result.status).toBe('OK')
    if (result.status !== 'OK') throw new Error('expected OK')
    expect(result.evidence).toContain(S6)
  })

  test('a garbled chunk is reported GARBLED, not silently dropped', () => {
    const garbled = `${'□ '.repeat(300)}${S1} ${'א ב ג '.repeat(60)}`
    const result = repairSourceWindow(garbled, { title: 'عنوان', summary: S2, excerpt: null })
    expect(result.status).toBe('GARBLED')
  })

  test('a chunk too short to ground anything is TOO_SHORT', () => {
    const result = repairSourceWindow('نص قصير جدا.', { title: 'عنوان', summary: S2, excerpt: null })
    expect(result.status).toBe('TOO_SHORT')
  })

  test('a healthy chunk that holds none of the item concepts is UNLOCATABLE', () => {
    const result = repairSourceWindow(bigChunk, {
      title: 'الفيزياء الكمية والجسيمات الأولية وتفاعلاتها',
      summary: 'تدرس الفيزياء الكمية سلوك الجسيمات الأولية وتفاعلاتها في المختبرات الحديثة.',
      excerpt: null,
    })
    expect(result.status).toBe('UNLOCATABLE')
  })
})

describe('assessRepairCandidate', () => {
  const evidence = `${S1} ${S2} ${S3}`
  const good = JSON.stringify({ title: S2, summary: `${S1} ${S2}`, excerpt: S3 })

  test('verbatim spans of the evidence are accepted', () => {
    const result = assessRepairCandidate(good, evidence)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.candidate.title).toBe(S2)
    expect(result.candidate.summary).toBe(`${S1} ${S2}`)
    expect(result.candidate.excerpt).toBe(S3)
  })

  test('an excerpt invented outside the evidence is NOT_GROUNDED, not saved', () => {
    const invented = JSON.stringify({
      title: S2,
      summary: `${S1} ${S2}`,
      excerpt: 'تتحدث هذه الفقرة عن موضوع لم يرد في النص الأصلي إطلاقا ولا يوجد له أثر فيه.',
    })
    const result = assessRepairCandidate(invented, evidence)
    expect(result).toEqual({ ok: false, reason: 'NOT_GROUNDED' })
  })

  test('an empty object answer is EMPTY_OBJECT', () => {
    expect(assessRepairCandidate('{}', evidence)).toEqual({ ok: false, reason: 'EMPTY_OBJECT' })
  })

  test('non-JSON output is INVALID_JSON', () => {
    expect(assessRepairCandidate('not json at all', evidence)).toEqual({ ok: false, reason: 'INVALID_JSON' })
  })

  test('markdown in a field is CLEAN_MISMATCH', () => {
    const marked = JSON.stringify({ title: `**${S2}**`, summary: `${S1} ${S2}`, excerpt: S3 })
    expect(assessRepairCandidate(marked, evidence)).toEqual({ ok: false, reason: 'CLEAN_MISMATCH' })
  })

  test('a still-broken field is STILL_BROKEN', () => {
    const broken = JSON.stringify({
      title: 'هذا شرح يتضمن بذرة سؤال من النص في وسطه عن الأصول المتداولة',
      summary: `${S1} ${S2}`,
      excerpt: S3,
    })
    expect(assessRepairCandidate(broken, evidence)).toEqual({ ok: false, reason: 'STILL_BROKEN' })
  })

  test('evidence the acceptance gate refuses is SOURCE_BROKEN', () => {
    const refusedEvidence = `${evidence} انظر كتاب المحاسبة المالية للمزيد من التفاصيل.`
    expect(assessRepairCandidate(good, refusedEvidence)).toEqual({ ok: false, reason: 'SOURCE_BROKEN' })
  })
})
