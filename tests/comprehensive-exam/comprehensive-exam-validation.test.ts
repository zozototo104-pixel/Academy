// Comprehensive exam — question validation (closed questions only).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { approvePendingQuestionsInBatches, parseSavedInternetExamPlan } from '../../src/components/aact/AdminComprehensiveExamTab'
import {
  parseComprehensiveCorrectAnswer,
  parseComprehensiveType,
  validateComprehensiveQuestion,
  internetAcademicTopicIssue,
  internetQuestionAcademicIssue,
  internetSourceAcademicIssue,
} from '../../src/lib/comprehensive-exam'

const mcq = {
  type: 'MCQ',
  text: 'أي مما يلي يُعد من الأصول المتداولة في القوائم المالية؟',
  options: ['النقدية', 'المباني', 'براءات الاختراع', 'الشهرة'],
  correctAnswer: '0',
}

describe('internet comprehensive exam — academic scope', () => {
  const specialization = 'الدكتوراه المهنية في إدارة الأعمال'

  test('rejects degree name and admissions topics, but accepts disciplinary topics', () => {
    expect(internetAcademicTopicIssue('دكتوراه إدارة الأعمال DBA', specialization)).not.toBeNull()
    expect(internetAcademicTopicIssue('شروط القبول في برنامج DBA', specialization)).not.toBeNull()
    expect(internetAcademicTopicIssue('الإدارة الاستراتيجية وتحليل الميزة التنافسية', specialization)).toBeNull()
    expect(internetAcademicTopicIssue('مناهج البحث العلمي التطبيقي', specialization)).toBeNull()
  })

  test('refuses degree-admissions sources even when their text is real', () => {
    expect(internetSourceAcademicIssue(
      'United International Business School - DBA',
      'يُعدّ برنامج دكتوراه إدارة الأعمال برنامجًا مهنيًا موجهاً نحو خريجي الماجستير في التخصصات ذات الصلة.',
    )).toBe('DEGREE_ADMISSIONS_SOURCE')
    expect(internetSourceAcademicIssue(
      'المحاسبة المالية',
      'الأصول المتداولة تشمل النقدية والذمم المدينة والمخزون، وتخضع لتحليل السيولة وإدارة رأس المال العامل.',
    )).toBeNull()
  })

  test('refuses degree trivia but preserves knowledge questions', () => {
    expect(internetQuestionAcademicIssue('من هي الفئة المستهدفة للالتحاق ببرنامج دكتوراه إدارة الأعمال DBA؟')).not.toBeNull()
    expect(internetQuestionAcademicIssue('ما هي الشروط الأساسية المذكورة للقبول في برنامج الـ DBA؟')).not.toBeNull()
    expect(internetQuestionAcademicIssue('يركز برنامج الـ DBA بشكل أساسي على تطبيق المعرفة النظرية لتحسين ممارسات الإدارة والأعمال.')).not.toBeNull()
    expect(internetQuestionAcademicIssue('هل الماجستير بعد البكالوريوس؟')).toBe('DEGREE_SEQUENCE_QUESTION')
    expect(internetQuestionAcademicIssue('هل شهادة الدكتوراه تتطلب الماجستير؟')).toBe('DEGREE_SEQUENCE_QUESTION')
    expect(internetQuestionAcademicIssue('كيف يؤثر التحليل المالي للسيولة في اتخاذ قرار تمويل رأس المال العامل؟')).toBeNull()
    expect(internetQuestionAcademicIssue('تُصنّف الذمم المدينة ضمن الأصول المتداولة في قائمة المركز المالي.')).toBeNull()
  })
})

describe('validateComprehensiveQuestion', () => {
  test('accepts a valid multiple-choice question', () => {
    const r = validateComprehensiveQuestion(mcq)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.question.type).toBe('MCQ')
    expect(r.question.options).toHaveLength(4)
    expect(r.question.correctAnswer).toBe('0')
  })

  test('accepts a true/false question and normalizes صح to 0', () => {
    const r = validateComprehensiveQuestion({
      type: 'صح/خطأ',
      text: 'تُقاس الأصول المتداولة بأنها الموارد المتوقع تحويلها إلى نقد.',
      options: ['نعم', 'لا'],
      correctAnswer: 'صح',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.question.type).toBe('TF')
    expect(r.question.options).toEqual(['صح', 'خطأ'])
    expect(r.question.correctAnswer).toBe('0')
  })

  test('accepts خطأ as the TF answer 1', () => {
    const r = validateComprehensiveQuestion({
      type: 'TF',
      text: 'المباني أصل متداول في القوائم المالية للمنشأة.',
      correctAnswer: 'خطأ',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.question.correctAnswer).toBe('1')
  })

  test('rejects ESSAY outright — no essay anywhere in this module', () => {
    const r = validateComprehensiveQuestion({
      type: 'ESSAY',
      text: 'اشرح بالتفصيل مفهوم الأصول المتداولة وأهميتها.',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected rejection')
    expect(r.errors.join(' ')).toContain('لا مقالي')
  })

  test('rejects SHORT the same way', () => {
    const r = validateComprehensiveQuestion({ type: 'SHORT', text: 'ما تعريف الأصل المتداول؟' })
    expect(r.ok).toBe(false)
  })

  test('rejects an MCQ with fewer than 3 options', () => {
    const r = validateComprehensiveQuestion({ ...mcq, options: ['النقدية', 'المباني'] })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected rejection')
    expect(r.errors.join(' ')).toContain('3–4')
  })

  test('rejects a correct answer outside the option range', () => {
    const r = validateComprehensiveQuestion({ ...mcq, correctAnswer: '7' })
    expect(r.ok).toBe(false)
  })

  test('resolves a correct answer given as option text', () => {
    const r = validateComprehensiveQuestion({ ...mcq, correctAnswer: 'المباني' })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.question.correctAnswer).toBe('1')
  })

  test('rejects a question text shorter than 10 characters', () => {
    const r = validateComprehensiveQuestion({ ...mcq, text: 'قصير' })
    expect(r.ok).toBe(false)
  })

  test('accepts a 1-based answer number', () => {
    const r = validateComprehensiveQuestion({ ...mcq, correctAnswer: '3' })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.question.correctAnswer).toBe('2')
  })
})

describe('parseComprehensiveType', () => {
  test('maps Arabic and English aliases', () => {
    expect(parseComprehensiveType('صح/خطأ')).toBe('TF')
    expect(parseComprehensiveType('TF')).toBe('TF')
    expect(parseComprehensiveType('اختيار متعدد')).toBe('MCQ')
    expect(parseComprehensiveType('MCQ')).toBe('MCQ')
    expect(parseComprehensiveType('مقالي')).toBe(null)
    expect(parseComprehensiveType('ESSAY')).toBe(null)
  })
})

describe('parseComprehensiveCorrectAnswer', () => {
  test('zero-based UI/stored answers retain all four MCQ positions', () => {
    const options = ['الأول', 'الثاني', 'الثالث', 'الرابع']
    for (let i = 0; i < options.length; i++) {
      expect(parseComprehensiveCorrectAnswer('MCQ', String(i), options, 0)).toBe(String(i))
      const checked = validateComprehensiveQuestion({ ...mcq, correctAnswer: String(i), correctAnswerIndexBase: 0 })
      expect(checked.ok).toBe(true)
      if (checked.ok) expect(checked.question.correctAnswer).toBe(String(i))
    }
    expect(parseComprehensiveCorrectAnswer('MCQ', '4', options, 0)).toBeNull()
  })

  test('legacy one-based numeric imports still resolve to zero-based storage', () => {
    expect(parseComprehensiveCorrectAnswer('MCQ', '1', mcq.options)).toBe('0')
    expect(parseComprehensiveCorrectAnswer('MCQ', '4', mcq.options)).toBe('3')
  })

  test('TF accepts صح/خطأ words', () => {
    expect(parseComprehensiveCorrectAnswer('TF', 'صح', ['صح', 'خطأ'])).toBe('0')
    expect(parseComprehensiveCorrectAnswer('TF', 'خطأ', ['صح', 'خطأ'])).toBe('1')
    expect(parseComprehensiveCorrectAnswer('TF', '2', ['صح', 'خطأ'])).toBe(null)
  })
})

describe('comprehensive exam review UX', () => {
  const view = readFileSync(join(import.meta.dir, '../../src/components/aact/AdminComprehensiveExamTab.tsx'), 'utf8')

  test('restores a reviewed blueprint with its selected axes, without accepting invalid local data', () => {
    const saved = parseSavedInternetExamPlan(JSON.stringify({
      axesText: 'الإدارة الاستراتيجية وتحليل الميزة التنافسية\nمناهج البحث التطبيقي',
      selectedTopics: { 'الإدارة الاستراتيجية وتحليل الميزة التنافسية': true, 'مناهج البحث التطبيقي': false },
      basis: 'MIXED', reviewed: true,
    }))
    expect(saved?.selectedTopics['الإدارة الاستراتيجية وتحليل الميزة التنافسية']).toBe(true)
    expect(saved?.selectedTopics['مناهج البحث التطبيقي']).toBeUndefined()
    expect(parseSavedInternetExamPlan('{broken')).toBeNull()
    expect(parseSavedInternetExamPlan(JSON.stringify({ axesText: 'محور واحد', selectedTopics: {}, reviewed: true }))).toBeNull()
    expect(parseSavedInternetExamPlan(JSON.stringify({ axesText: 'الإدارة الاستراتيجية وتحليل الميزة التنافسية', selectedTopics: { 'الإدارة الاستراتيجية وتحليل الميزة التنافسية': true }, reviewed: false }))).toBeNull()
  })

  test('persists the reviewed blueprint and monitors background progress after refresh', () => {
    expect(view).toContain('localStorage.setItem(internetExamPlanStorageKey(examId)')
    expect(view).toContain('localStorage.getItem(internetExamPlanStorageKey(examId))')
    expect(view).toContain('استكمال الأسئلة الناقصة')
    expect(view).toContain('internetPlanStored')
    expect(view).toContain("action: 'BACKGROUND_STATUS'")
    expect(view).toContain('window.setInterval(() => { void poll() }, 10_000)')
    expect(view).toContain('onStopInternetPlan={pauseComprehensiveInternetPlan}')
  })

  test('keeps the question panel mounted during approval and edit refresh', () => {
    expect(view).toContain('const loadDetail = async (examId: string, showLoading = true)')
    expect(view).toContain('if (showLoading) setDetailLoading(true)')
    expect(view).toContain('if (showLoading) setDetailLoading(false)')
    expect(view).toContain('loadDetail(examId, false), loadExams()')
    expect(view).toContain('onClick={() => loadDetail(exam.id)}')
  })

  test('select-all approves only pending questions via existing guarded PATCH', () => {
    expect(view).toContain('تحديد الكل')
    expect(view).toContain('اعتماد المحدد')
    expect(view).toContain("q.status === 'PENDING_REVIEW'")
    expect(view).toContain("body: JSON.stringify({ status: 'APPROVED' })")
    expect(view).toContain('bulkApproveLock.current = true')
    expect(view).toContain('bulkApproveLock.current = false')
  })

  test('specialty-wide internet generation queues a reviewed blueprint for server-side work', () => {
    expect(view).toContain('تحضير محاور التخصص')
    expect(view).toContain('كتابة المحاور يدوياً')
    expect(view).toContain('تحديد جميع المحاور')
    expect(view).toContain('internetSelectedTopics[topic]')
    expect(view).toContain('const chosenAxes = writtenAxes.filter')
    expect(view).toContain('توليد الأسئلة حسب المخطط')
    expect(view).toContain('!internetPlanReviewed')
    expect(view).toContain("action: 'BACKGROUND_START', axes: chosenAxes, reviewed: true")
    expect(view).toContain("action: 'BACKGROUND_PAUSE'")
    expect(view).toContain('تستطيع الخروج من الصفحة')
    expect(view).not.toContain('internetStopRef')
  })

  test('batch approval preserves each success and reports failed academic validation', async () => {
    const visited: string[] = []
    const result = await approvePendingQuestionsInBatches(
      [{ id: 'a', order: 1 }, { id: 'bad', order: 2 }, { id: 'a', order: 1 }, { id: 'c', order: 3 }],
      async (id) => {
        visited.push(id)
        if (id === 'bad') throw new Error('السؤال خارج التخصص')
      },
    )
    expect(visited.sort()).toEqual(['a', 'bad', 'c'])
    expect(result.approvedIds).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ id: 'bad', order: 2, reason: 'السؤال خارج التخصص' }])
  })

  test('batch approval limits concurrency to four and reports progress', async () => {
    let concurrent = 0
    let peak = 0
    const progress: number[] = []
    const result = await approvePendingQuestionsInBatches(
      Array.from({ length: 9 }, (_, i) => ({ id: `q-${i}`, order: i + 1 })),
      async () => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 2))
        concurrent--
      },
      (processed) => progress.push(processed),
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(progress).toEqual([4, 8, 9])
    expect(result.approvedIds).toHaveLength(9)
  })
})
