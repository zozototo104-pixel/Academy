// حارس تصنيف التخزين (فحص 2026-10-30، بند التخزين): ملفات الأطروحات
// وتسجيلات المناقشة يجب أن تُصنَّف خاصة — أي بلا روابط عامة مباشرة،
// وقراءتها عبر /api/files بفحص ملكية — لا عامة كما كانت بسبب اختلاف
// البادئة («thesis/» عند الرفع مقابل «theses/» في القائمة).
import { describe, expect, test } from 'bun:test'
import { isPrivateStorageKey } from '@/lib/prod-safety'

describe('تصنيف مفاتيح التخزين', () => {
  test('ملفات الأطروحات خاصة ببادئة الرفع الفعلية', () => {
    expect(isPrivateStorageKey('thesis/abc123-thesis.pdf')).toBe(true)
    expect(isPrivateStorageKey('thesis')).toBe(true)
    expect(isPrivateStorageKey('theses/old.pdf')).toBe(true) // البادئة القديمة تبقى خاصة
  })

  test('تسجيلات المناقشة خاصة', () => {
    expect(isPrivateStorageKey('defense-recordings/user-1/rec.webm')).toBe(true)
    expect(isPrivateStorageKey('defense-recordings/user-1')).toBe(true)
  })

  test('البادئات الخاصة القائمة لم تتغير', () => {
    for (const key of ['admissions/REF-1/id.pdf', 'payment-proofs/p1.png', 'assignments/a1/f.pdf', 'backups/db.sql', 'service-deliverables/d1.pdf', 'representatives-private/r1.pdf']) {
      expect(isPrivateStorageKey(key)).toBe(true)
    }
  })

  test('المحتوى العام يبقى عاماً (لا كسر لروابط الكتب والصور العامة)', () => {
    for (const key of ['books/book-1.pdf', 'covers/c1.png', 'lecture-videos/lv1.mp4', 'thesisx/not-a-thesis.pdf', 'my-thesis/file.pdf']) {
      expect(isPrivateStorageKey(key)).toBe(false)
    }
  })

  test('التطبيع: شرطات مائلة وحروف كبيرة لا تهرب من التصنيف', () => {
    expect(isPrivateStorageKey('Thesis/ABC.pdf')).toBe(true)
    expect(isPrivateStorageKey('\\\\defense-recordings\\\\u1\\\\r.webm')).toBe(true)
    expect(isPrivateStorageKey('/thesis/x.pdf')).toBe(true)
  })
})
