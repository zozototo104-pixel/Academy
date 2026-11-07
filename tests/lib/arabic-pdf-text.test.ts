import { describe, expect, test } from 'bun:test'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'

// Guard suite for the PDF-extraction text repair (defect reported by the
// owner 2026-11-07 from the PMI outline: «بعض الكلمات للعناوين معكوسة» —
// المشروع stored as «املشروع», المؤثرات as «املؤثرات»). The extractor
// transposes lam-meem at the start of some words, the same artifact
// family the fixer already repairs for lam-alef. Pins:
//  - every attested broken form is repaired (incl. proclitic prefixes);
//  - genuine «امل» words are never reordered (أملاك, possessives of
//    أمل, and short words like املك), and mid-word «امل» in correct
//    words (كامل، شامل، التعامل) is untouched;
//  - already-correct text and the older lam-alef fixes are unchanged;
//  - the repair is idempotent.

describe('تصحيح انقلاب اللام والميم أول الكلمة', () => {
  test('الأشكال المكسورة المشاهدة في فهرس إدارة المشاريع تُصلَح', () => {
    expect(fixArabicPdfText('إدارة املشروع')).toBe('إدارة المشروع')
    expect(fixArabicPdfText('املؤثرات التنظيمية ودورة حياة املشروع')).toBe('المؤثرات التنظيمية ودورة حياة المشروع')
    expect(fixArabicPdfText('إدارة املخاطر باملشروع')).toBe('إدارة المخاطر بالمشروع')
    expect(fixArabicPdfText('إدارة املوارد البشرية')).toBe('إدارة الموارد البشرية')
    expect(fixArabicPdfText('الفصل الأول: إدارة املشاريع')).toBe('الفصل الأول: إدارة المشاريع')
    expect(fixArabicPdfText('عمليات إدارة املشروع')).toBe('عمليات إدارة المشروع')
  })

  test('حروف الجر والعطف الملتصقة لا تحمي الكلمة المكسورة', () => {
    expect(fixArabicPdfText('باملشروع')).toBe('بالمشروع')
    expect(fixArabicPdfText('فاملخاطر')).toBe('فالمخاطر')
    expect(fixArabicPdfText('واملشروع')).toBe('والمشروع')
  })

  test('الكلمات السليمة التي تبدأ أو تحتوي «امل» لا تُلمَس', () => {
    expect(fixArabicPdfText('المشروع')).toBe('المشروع')
    expect(fixArabicPdfText('للمشروع')).toBe('للمشروع')
    expect(fixArabicPdfText('إدارة املاك الدولة')).toBe('إدارة املاك الدولة')
    expect(fixArabicPdfText('املنا كبير واملهم باقٍ')).toBe('املنا كبير واملهم باقٍ')
    expect(fixArabicPdfText('عندي امل')).toBe('عندي امل')
    expect(fixArabicPdfText('املك بيتا في القرية')).toBe('املك بيتا في القرية')
    expect(fixArabicPdfText('العامل الكامل والشامل')).toBe('العامل الكامل والشامل')
    expect(fixArabicPdfText('التعامل بالمعروف')).toBe('التعامل بالمعروف')
    expect(fixArabicPdfText('الاملاك العامة')).toBe('الاملاك العامة')
  })

  test('إصلاحات اللام والألف القديمة ما زالت تعمل', () => {
    expect(fixArabicPdfText('إال')).toBe('إلا')
    expect(fixArabicPdfText('بال التكاليف')).toBe('بلا التكاليف')
  })

  test('التصحيح ثابت عند التكرار (idempotent)', () => {
    const broken = 'املؤثرات التنظيمية ودورة حياة املشروع'
    const once = fixArabicPdfText(broken)
    expect(fixArabicPdfText(once)).toBe(once)
  })
})
