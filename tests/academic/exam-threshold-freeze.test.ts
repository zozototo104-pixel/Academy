import { describe, expect, test } from 'bun:test'
import { isPublishedExamStatus, pinThresholdIfPublished } from '../../src/lib/exam-threshold'

// T2 — شرط إغلاق المرحلة الثالثة (قرار المالك 2026-11-05): تغيير حدّ نجاح
// امتحان منشور لا يغيّر تصنيف محاولاته السابقة. التصنيف يُحسب دائمًا من
// حدّ صفّ الامتحان نفسه (ناجح ⟺ الدرجة ≥ الحدّ)، فتثبيت الحدّ بعد النشر
// هو ما يجعل التصنيفات المحفوظة والمعاد حسابها ثابتة عبر الزمن.
const classify = (score: number, passScore: number) => score >= passScore

describe('حدّ نجاح الامتحان — دورة الحياة', () => {
  test('قبل النشر: الحدّ تشغيلي ويُعدَّل بحرية', () => {
    for (const status of ['DRAFT', 'REVIEW', 'GENERATING', 'PAUSED']) {
      const r = pinThresholdIfPublished({ status, passScore: 60 }, { passScore: 45 })
      expect(r.pinned).toBe(false)
      expect(r.data.passScore).toBe(45)
    }
    const created = pinThresholdIfPublished(null, { passScore: 70 })
    expect(created.pinned).toBe(false)
    expect(created.data.passScore).toBe(70)
  })

  test('بعد النشر: أي تحديث بحدّ مختلف يُثبَّت على القيمة الحالية', () => {
    const r = pinThresholdIfPublished({ status: 'READY', passScore: 60 }, { passScore: 50, title: 'x' })
    expect(r.pinned).toBe(true)
    expect(r.data.passScore).toBe(60)
    const same = pinThresholdIfPublished({ status: 'READY', passScore: 60 }, { passScore: 60 })
    expect(same.pinned).toBe(false)
    expect(isPublishedExamStatus('READY')).toBe(true)
    expect(isPublishedExamStatus('DRAFT')).toBe(false)
  })

  test('T2: محاولات امتحان منشور تبقى مصنّفة كما كانت بعد محاولة تغيير الحدّ', () => {
    // امتحان منشور بحدّ 60، ومحاولتان محفوظتان: 55 راسب و65 ناجح.
    const exam = { status: 'READY', passScore: 60 }
    const attempts = [{ score: 55 }, { score: 65 }]
    const before = attempts.map((a) => classify(a.score, exam.passScore))
    expect(before).toEqual([false, true])
    // محاولة تحديث لاحقة (استيراد كتالوج / إعادة توليد) تطلب حدًّا 50:
    const { data, pinned } = pinThresholdIfPublished(exam, { passScore: 50 })
    expect(pinned).toBe(true)
    const after = attempts.map((a) => classify(a.score, data.passScore))
    expect(after).toEqual(before)
    // وإعادة المحاولة على نفس الإصدار تُحسب بنفس الحدّ المثبّت:
    expect(classify(55, data.passScore)).toBe(false)
  })

  test('إصدار جديد بحدّ مختلف يصنّف محاولاته هو — بلا أثر رجعي', () => {
    const newVersion = { status: 'READY', passScore: 50 }
    expect(classify(55, newVersion.passScore)).toBe(true)
    // بينما تبقى محاولة الإصدار القديم راسبة بحدّ إصدارها:
    expect(classify(55, 60)).toBe(false)
  })
})
