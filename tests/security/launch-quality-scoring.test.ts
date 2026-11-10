// حارس دقة مقيّم مجسات جاهزية الإطلاق (قرار صاحب المنصة 2026-11-10):
// المطابقة الحرفية رفضت في بوابة #716 إجابة مناقشة صحيحة ومرتبطة بالبحث
// (وكيل صحيح THESIS_DEFENSE وgrounded لكن keywordScore=0) لأنها صاغت
// مفاهيم البحث بكلمات مختلفة عن العبارات الحرفية. الإصلاح: مجموعات مفاهيم
// مبنية حصراً من بيانات الطالب الموثوقة قبل التقييم، بصيغ موثّقة لكل
// مفهوم، مع بقاء كل الحرّاس (الوكيل، الارتباط، رفض العام، الطول، الحد
// الأدنى). هذه الاختبارات حتمية ولا تستدعي أي مزوّد.
//
// حالة النجاح الأولى هي النص الحرفي لإجابة #716 كما ظهر في سجل تشغيل
// البوابة (استُبدلت بها إعادة البناء السابقة بأمر صاحب المنصة
// 2026-11-10): سؤال لجنة يميّز بين مؤشرات الأداء ومؤشرات المخاطر (KRI)
// ويختم بـ«الحوكمة» مجردة — وهي ليست صيغة معتمدة لمفهوم «الحوكمة
// المؤسسية» فيبقى ذلك المفهوم missed عمداً، وتنجح الإجابة بمفهومي
// العنوان والمخاطر (67 نقطة).
import { describe, expect, test } from 'bun:test'
import {
  evaluateProbeReply,
  groundedForProbe,
  scoreConcepts,
  conceptGroupFor,
  type ProbeStudentContext,
} from '../../src/lib/launch-quality-scoring'

const THESIS_TITLE = 'أثر مؤشرات المخاطر الرئيسية على فعالية الحوكمة المؤسسية'

const CONTEXT_A: ProbeStudentContext = {
  studentName: 'طالب فحص جاهزية الإطلاق',
  programTitle: 'برنامج فحص جاهزية الإطلاق في الحوكمة وإدارة المخاطر',
  firstBook: 'دليل الحوكمة وإدارة المخاطر المؤسسية',
  firstUnit: 'مدخل إلى الحوكمة وإدارة المخاطر',
  thesisTitle: THESIS_TITLE,
  reference: 'AACT-LAUNCH-QUALITY',
}

const DEFENSE_EXPECTED = [THESIS_TITLE, 'مؤشرات المخاطر الرئيسية', 'الحوكمة المؤسسية']

const DEFENSE_716_REPLY =
  'سؤالي: في بحثك، كيف تميّز بين مؤشرات الأداء (KPI) ومؤشرات المخاطر (KRI) عند ربط كل مؤشر بمالك واضح، وما تأثير هذا الربط على فعالية الضوابط؟\n\nالسبب: لأن الخلط بينهما يضعف قدرة الإدارة على التصعيد المبكر، وقد يجعل المؤشر يقيس الإنجاز بدلاً من الإنذار، وهذا يمسّ جوهر منهجيتك في قياس أثر مؤشرات المخاطر على الحوكمة.'

function evaluateDefense(reply: string, overrides: Partial<Parameters<typeof evaluateProbeReply>[0]> = {}) {
  return evaluateProbeReply({
    kind: 'DEFENSE',
    reply,
    agentMatches: true,
    expected: DEFENSE_EXPECTED,
    context: CONTEXT_A,
    minScore: 40,
    ...overrides,
  })
}

describe('launch-quality concept scoring (owner ruling 2026-11-10)', () => {
  test('النص الحرفي لإجابة #716 من سجل التشغيل ينجح (67 نقطة)', () => {
    // وكيل THESIS_DEFENSE صحيح وgrounded لكن الرد رُفض يومها بـ
    // keywordScore=0. مفهوم الحوكمة يبقى missed عمداً: الرد يختم
    // بـ«الحوكمة» مجردة وهي ليست صيغة معتمدة للمفهوم — أي تغيير لهذه
    // النتيجة الدقيقة يجب أن يكون قراراً واعياً في جدول الصيغ.
    const result = evaluateDefense(DEFENSE_716_REPLY)
    expect(result.grounded).toBe(true)
    expect(result.keywordScore).toBe(67)
    expect(result.hits).toContain(THESIS_TITLE)
    expect(result.hits).toContain('مؤشرات المخاطر الرئيسية')
    expect(result.missed).toContain('الحوكمة المؤسسية')
    expect(result.passed).toBe(true)
  })

  test('إجابة عامة عن الحوكمة دون بحث الطالب تفشل', () => {
    const generic =
      'الحوكمة المؤسسية ركيزة أساسية في نجاح المنظمات الحديثة، فهي تضمن الشفافية والمساءلة وحماية حقوق المساهمين، ' +
      'وتلتزم المؤسسات بتطبيق معاييرها عبر مجالس إدارة فعّالة ولجان مراجعة مستقلة وسياسات إفصاح واضحة المعالم ومعلنة.'
    const result = evaluateDefense(generic)
    expect(result.grounded).toBe(false)
    expect(result.passed).toBe(false)
  })

  test('ذكر عنوان البحث حرفياً دون مناقشة مفاهيمه يفشل', () => {
    const titleOnly =
      `بحثي عنوانه: ${THESIS_TITLE}. أرجو أن تسألني عنه في جلسة المناقشة القادمة إن شاء الله، ` +
      'وأنا مستعد للإجابة عن أسئلة اللجنة كاملة في الموعد المحدد لنا، وشكراً لكم على وقتكم وجهدكم.'
    const result = evaluateDefense(titleOnly)
    expect(result.keywordScore).toBeLessThan(40)
    expect(result.missed).toContain('مؤشرات المخاطر الرئيسية')
    expect(result.missed).toContain('الحوكمة المؤسسية')
    expect(result.passed).toBe(false)
  })

  test('استقلال المقيّم: إجابة بحث (أ) لا تنجح لبحث مختلف للطالب (ب)', () => {
    const contextB: ProbeStudentContext = {
      ...CONTEXT_A,
      thesisTitle: 'أثر التحول الرقمي على رضا العملاء في البنوك التجارية',
    }
    const result = evaluateDefense(DEFENSE_716_REPLY, {
      expected: ['أثر التحول الرقمي على رضا العملاء في البنوك التجارية', 'مؤشرات المخاطر الرئيسية', 'الحوكمة المؤسسية'],
      context: contextB,
    })
    expect(result.grounded).toBe(false)
    expect(result.passed).toBe(false)
  })

  test('فشل أي حارس مستقل يبقي النتيجة فاشلة رغم تحقق المفاهيم', () => {
    expect(evaluateDefense(DEFENSE_716_REPLY, { agentMatches: false }).passed).toBe(false)
    const genericFallback = evaluateDefense(`سأعطيك جواباً مباشراً. ${DEFENSE_716_REPLY}`)
    expect(genericFallback.genericFallback).toBe(true)
    expect(genericFallback.keywordScore).toBe(0)
    expect(genericFallback.passed).toBe(false)
    expect(evaluateDefense('ما رأيك بمؤشرات المخاطر وحوكمة المؤسسات؟').passed).toBe(false)
  })

  test('غياب عنوان البحث: حالة تشخيصية صريحة ولا نجاح تلقائي', () => {
    const result = evaluateDefense(DEFENSE_716_REPLY, {
      expected: [CONTEXT_A.programTitle!, 'مؤشرات المخاطر الرئيسية', 'الحوكمة المؤسسية'],
      context: { ...CONTEXT_A, thesisTitle: undefined },
    })
    expect(result.contextSufficient).toBe(false)
    expect(result.note).toBe('INSUFFICIENT_THESIS_CONTEXT')
    expect(result.passed).toBe(false)
  })
})

describe('launch-quality scoring keeps the healthy paths healthy', () => {
  test('مجس البحث: صيغ منهج البحث ونتائج الدراسة تُحتسب', () => {
    const reply =
      `بحثك الحالي عنوانه ${THESIS_TITLE}. في منهج البحث اعتمدت على تحليل كمي لبيانات ثلاث سنوات، ` +
      'ونتائج الدراسة المتوقعة ستظهر أثراً واضحاً، ونقطة الضعف الأهم هي صغر حجم العيّنة مقارنة بالمجتمع الكلي للدراسة.'
    const result = evaluateProbeReply({
      kind: 'THESIS',
      reply,
      agentMatches: true,
      expected: [THESIS_TITLE, 'منهجية', 'نتائج'],
      context: CONTEXT_A,
      minScore: 40,
    })
    expect(result.keywordScore).toBe(100)
    expect(result.passed).toBe(true)
  })

  test('مجس الملف: الاسم والبرنامج والمرجع حرفياً كما كان', () => {
    const reply =
      'أنت طالب فحص جاهزية الإطلاق، مسجل في برنامج فحص جاهزية الإطلاق في الحوكمة وإدارة المخاطر، ' +
      'ورقمك المرجعي AACT-LAUNCH-QUALITY، وحالة طلبك نشطة، وأنصحك بالتركيز الآن على إكمال وحدات الفصل الحالي قبل موعد الامتحان.'
    const result = evaluateProbeReply({
      kind: 'PROFILE',
      reply,
      agentMatches: true,
      expected: ['طالب فحص جاهزية الإطلاق', CONTEXT_A.programTitle!, 'AACT-LAUNCH-QUALITY'],
      context: CONTEXT_A,
      minScore: 40,
    })
    expect(result.keywordScore).toBe(100)
    expect(result.passed).toBe(true)
  })

  test('المفاهيم تُبنى من بيانات الطالب لا من الرد: مجموعة المفهوم ثابتة قبل التقييم', () => {
    const group = conceptGroupFor('مؤشرات المخاطر الرئيسية', THESIS_TITLE)
    expect(group.variants).toContain('موشرات المخاطر')
    const scored = scoreConcepts(DEFENSE_716_REPLY, [group], THESIS_TITLE)
    expect(scored.hits).toContain('مؤشرات المخاطر الرئيسية')
    expect(groundedForProbe('DEFENSE', DEFENSE_716_REPLY, CONTEXT_A)).toBe(true)
  })
})
