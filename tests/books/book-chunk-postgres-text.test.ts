import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripPostgresForbiddenChars } from '../../src/lib/postgres-text'
import { formatNumberedBookLines, resolveBookLineEvidence } from '../../src/lib/text-provenance'

// Regression for the 2026-11-23 live failure: a book page whose PDF text
// layer embeds a NUL byte (0x00) made prisma.bookChunk.upsert() fail with
// Postgres 22021 "invalid byte sequence for encoding UTF8" and stalled the
// whole read job — retrying re-read the same page and failed identically.
// Chunk text must be stripped of Postgres-forbidden characters before it
// is saved. A direct planBookChunks behaviour test cannot run here: importing
// src/lib/book-reader.ts pulls in the Prisma client, which is not generated
// in this sandbox — so the sanitizer itself is tested behaviourally below
// and its wiring into planBookChunks is pinned by source, the same pattern
// as tests/books/book-read-failure-honesty.test.ts.

describe('stripPostgresForbiddenChars', () => {
  it('removes NUL bytes from Arabic PDF text', () => {
    expect(stripPostgresForbiddenChars('مبادئ\u0000المحاسبة 2')).toBe('مبادئالمحاسبة 2')
  })

  it('removes other forbidden C0 controls and DEL', () => {
    expect(stripPostgresForbiddenChars('a\u0001b\u001Fc\u007Fd')).toBe('abcd')
  })

  it('keeps tab, newline and carriage return, which Postgres allows', () => {
    expect(stripPostgresForbiddenChars('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })

  it('leaves clean text untouched', () => {
    const clean = 'يتضمن مجموعة الرموز العربية'
    expect(stripPostgresForbiddenChars(clean)).toBe(clean)
  })

  it('returns empty for text made only of forbidden characters', () => {
    expect(stripPostgresForbiddenChars('\u0000\u0001')).toBe('')
  })
})

describe('planBookChunks wiring', () => {
  const bookReader = readFileSync(join(import.meta.dir, '..', '..', 'src/lib/book-reader.ts'), 'utf8')

  it('sanitizes the chunk text inside planBookChunks before hashing', () => {
    expect(bookReader).toContain("import { stripPostgresForbiddenChars } from '@/lib/postgres-text'")
    expect(bookReader).toContain('stripPostgresForbiddenChars(text.trim())')
  })

  it('sanitizes the heading path too', () => {
    expect(bookReader).toContain('stripPostgresForbiddenChars(headingPath)')
  })
})

describe('source-backed numbered-line evidence', () => {
  const lines = [
    'تعرف المحاسبة بأنها نظام لجمع وتسجيل وتصنيف العمليات المالية وتلخيصها بصورة تساعد على اتخاذ القرارات الإدارية.',
    'تظهر الأصول والالتزامات وحقوق الملكية في قائمة المركز المالي خلال فترة محاسبية محددة لضمان اتساق التقارير.',
    'يعتمد توثيق العمليات على المستندات الأصلية والأدلة المحاسبية وسجلات القيد المنظمة داخل المنشأة.',
    'توضح قائمة الدخل إيرادات المنشأة ومصروفاتها وصافي نتيجة النشاط خلال الفترة المالية.',
    'تربط الدورة المحاسبية بين دفتر اليومية والأستاذ وميزان المراجعة والقوائم الختامية.',
    'يساعد تحليل البيانات المالية في تقييم السيولة والربحية وقدرة المؤسسة على الوفاء بالالتزامات.',
    'يراجع المحاسب السياسات المحاسبية دورياً لتحسين موثوقية التقارير وملاءمتها للجهات المستفيدة.',
  ]
  const source = lines.join('\n')

  it('numbers the original lines without changing their content', () => {
    expect(formatNumberedBookLines(source).startsWith(`1 | ${lines[0]}\n2 | ${lines[1]}`)).toBe(true)
  })

  it('derives an exact contiguous source span from a valid range', () => {
    expect(resolveBookLineEvidence(source, '2', 4)).toEqual({ ok: true, excerpt: lines.slice(1, 4).join('\n') })
    expect(source).toContain(lines.slice(1, 4).join('\n'))
  })

  it('rejects malformed, reversed, out-of-bound, and over-six-line ranges', () => {
    for (const [from, to] of [[0, 1], [4, 2], [1, 8], ['none', 2], [1, 7], [2.2, 3]]) {
      expect(resolveBookLineEvidence(source, from, to)).toEqual({ ok: false, reason: 'INVALID_LINE_RANGE' })
    }
  })

  it('rejects excerpts under 60 characters', () => {
    expect(resolveBookLineEvidence('نص قصير', 1, 1)).toEqual({ ok: false, reason: 'EVIDENCE_TOO_SHORT' })
  })

  it('permits an original long line over 600 characters without paraphrasing it', () => {
    const longLine = lines[0].repeat(8)
    expect(longLine.length).toBeGreaterThan(600)
    expect(resolveBookLineEvidence(longLine, 1, 1)).toEqual({ ok: true, excerpt: longLine })
  })
})
