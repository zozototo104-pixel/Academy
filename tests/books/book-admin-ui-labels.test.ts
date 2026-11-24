// Source pins for the PR #212 admin UI wiring (final pass): the enrichment
// completion-kind label and the AI-repair per-reason counters must stay
// rendered in AdminBooks.tsx. These pin the wiring only — the API fields
// themselves are proven by the enrichment-target and AI-repair test files.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync('src/components/aact/AdminBooks.tsx', 'utf8')

describe('PR #212 admin UI wiring', () => {
  test('enrichment completion kind flows from API to a visible label', () => {
    expect(SOURCE).toContain("completionKind?: EnrichmentCompletionKind")
    expect(SOURCE).toContain('function withEnrichmentCompletion')
    expect(SOURCE).toContain('withEnrichmentCompletion(response.enrichment!)')
    expect(SOURCE).toContain('اكتمل الإثراء الأساسي (10 عناصر لكل مقطع)')
    expect(SOURCE).toContain('تشبع نهائي (20 عنصراً لكل مقطع)')
  })

  test('AI repair per-reason counters are rendered', () => {
    expect(SOURCE).toContain('garbledSource?: number')
    expect(SOURCE).toContain('rejectedCorrections?: number')
    expect(SOURCE).toContain('ocrRereads?: number')
    expect(SOURCE).toContain('مصدر مشوّه:')
    expect(SOURCE).toContain('مصدر غير قابل للتحديد:')
    expect(SOURCE).toContain('تصحيحات مرفوضة:')
    expect(SOURCE).toContain('إعادة قراءة OCR:')
    expect(SOURCE).toContain('أسباب الرفض:')
  })
})
