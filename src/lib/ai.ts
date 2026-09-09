import ZAI from 'z-ai-web-dev-sdk'
import { ACADEMY_INFO, ADMISSION_FEES, ADMISSION_GUIDE, ACCREDITATION_GUIDE } from '@/lib/academyData'
import { ensureGeminiKey, geminiComplete, isAuthError, isQuotaError, isModelUnavailableError, isInvalidArgumentError } from '@/lib/gemini'

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

export async function getZAI() {
  if (!zaiInstance) zaiInstance = await ZAI.create()
  return zaiInstance
}

/** استدعاء النموذج مع إعادة محاولة تلقائية عند ضغط المعدل (429) أو فراغ الاستجابة */
export async function chatWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  messages: { role: string; content: string }[],
  retries = 4
): Promise<string> {
  let lastErr: any
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const completion = await zai.chat.completions.create({
        messages,
        thinking: { type: 'disabled' },
      })
      const content = completion.choices[0]?.message?.content
      if (!content || !content.trim()) throw new Error('EMPTY_AI_RESPONSE')
      return content.trim()
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message || '')
      const rateLimited = msg.includes('429') || msg.toLowerCase().includes('too many')
      console.error(`AI attempt ${attempt}/${retries} failed:`, msg.slice(0, 120))
      if (attempt < retries) {
        // انتظار أطول عند ضغط المعدل
        await new Promise((r) => setTimeout(r, rateLimited ? 5000 * attempt : 2000 * attempt))
      }
    }
  }
  throw lastErr
}

export function buildSupervisorSystemPrompt(context?: string): string {
  return `أنت "المشرف الذكي" — المرشد الأكاديمي المعتمد لطلاب ${ACADEMY_INFO.nameAr} (${ACADEMY_INFO.nameEn})، تأسست ${ACADEMY_INFO.founded}.

هويتك ودورك:
- مشرف أكاديمي ودود ومحترف يرافق كل طالب في رحلته التدريبية
- تجيب على استفسارات الطلاب حول: محتوى الوحدات التدريبية، مفاهيم الاستشارة المهنية، إجراءات الالتحاق، الرسوم، الشهادات، الاعتمادات، نظام الوكلاء الدوليين
- تشرح المفاهيم بأسلوب تعليمي مبسط مع أمثلة عملية من الواقع
- تشجع الطالب وتقترح خطوات تالية لتحسين تعلمه
- تجيب دائماً بالعربية الفصحى المبسطة بأسلوب ودود

معلومات الأكاديمية:
- الشعار: "${ACADEMY_INFO.taglineAr}" (${ACADEMY_INFO.taglineEn})
- البريد: ${ACADEMY_INFO.email} | واتساب: ${ACADEMY_INFO.whatsapp}
- البرامج: ${ACADEMY_INFO.programs}
- الشهادات تُصدر خلال ${ACADEMY_INFO.certificateDays} يوماً من استلام كشوف الدرجات والرسوم
- الوكلاء الدوليون: نسبة ${ACADEMY_INFO.agentCommission} من إيرادات منطقة التمثيل + ${ACADEMY_INFO.researchFee} عن كل بحث تخرج يشارك الوكيل في لجنة مناقشته

دليل إجراءات وشروط الالتحاق (معلومات رسمية دقيقة — استخدمها عند أي سؤال عن التسجيل أو الرسوم):
- شروط القبول: ${ADMISSION_GUIDE.conditions.join(' / ')}
- الوثائق المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}
- خطوات التسجيل: ${ADMISSION_GUIDE.steps.join(' ← ')}
- رسوم تقديم الطلب وحجز المقعد: ${ADMISSION_FEES.applicationFee}$ غير مستردة
- التكلفة المالية: الدكتوراه المهنية (معادلة خبرات) ${ADMISSION_FEES.doctorate}$ — الماجستير المهني (معادلة خبرات) ${ADMISSION_FEES.masters}$ — الدبلومات والبرامج الدولية من ${ADMISSION_FEES.diplomasRange}$ حسب البرنامج
- متطلبات التخرج: ${ADMISSION_GUIDE.graduation.join(' / ')}
- مدة بحث التخرج: من 3 إلى 6 شهور كحد أقصى، تتم مناقشته من قبل لجنة متخصصة
- ملاحظة رسمية: ${ADMISSION_GUIDE.note}

دليل الاعتمادات الدولية (نظام الاعتماد والعضوية الأمريكية):
- رسوم تقديم طلب الاعتماد: ${ACCREDITATION_GUIDE.applicationFee}$ غير مستردة
- أنواع الاعتماد ورسومها: الهيئات التدريبية (شركات/مؤسسات/مراكز) 1000$ — المستشارون (إداري ومالي، تربوي، قانوني، نفسي، هندسي، ذكاء اصطناعي) 350$ — المدرب الدولي المعتمد 200$ — اعتماد الجودة حسب طبيعة الاعتماد
- مميزات الاعتماد: ${ACCREDITATION_GUIDE.benefits.join(' / ')}
- برامج العام 2026-2027 تشمل: الماجستير والدكتوراة المهنية (كافة التخصصات باستثناء الطب)، 15 شهادة دولية (GRCP، PMP، CBP، APHRI، CCNA، OSHA، PFA، CPd-AI وغيرها)، وأكثر من 30 دبلومة تدريبية (موارد بشرية، تسويق، مشاريع، إدارة صحية، جودة شاملة، صعوبات تعلم، إعداد مدربين TOT وغيرها)

تعليمات مهمة:
- إذا سُئلت عن موضوع خارج نطاق الأكاديمية أو المحتوى التدريبي، أجب بأدب ووجّه الطالب للموضوعات المتاحة
- إذا سُئلت عن معلومات إدارية دقيقة غير متوفرة لديك (مثل حالة دفعة مالية خاصة)، اطلب التواصل مع الإدارة عبر البريد ${ACADEMY_INFO.email}
- أبقِ إجاباتك موجزة ومركزة (2-4 فقرات كحد أقصى) لأنها قد تُقرأ صوتياً
- لا تستخدم رموز Markdown معقدة (مثل جداول أو ##) لأن الإجابة قد تُنطق صوتياً — استخدم نصاً عادياً وقوائم بسيطة

${context ? `سياق إضافي عن الوحدة/الدورة الحالية للطالب:\n${context}` : ''}`
}

export async function chatComplete(
  messages: { role: string; content: string }[],
  context?: string
): Promise<string> {
  const zai = await getZAI()
  const systemPrompt = buildSupervisorSystemPrompt(context)
  const completion = await zai.chat.completions.create({
    messages: [
      // ملاحظة: SDK Z-AI لا يقبل role 'system' في النوع — البرومبت النظامي يمر كرسالة أولى
      { role: 'assistant', content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
    ],
    thinking: { type: 'disabled' },
  })
  const content = completion.choices[0]?.message?.content
  if (!content || !content.trim()) throw new Error('EMPTY_AI_RESPONSE')
  return content.trim()
}

export interface GradedAnswer {
  index: number
  points: number
  maxPoints: number
  feedback: string
}

export interface GradeResult {
  totalScore: number
  maxTotal: number
  percentage: number
  passed: boolean
  answers: GradedAnswer[]
  summary: string
  strengths: string[]
  improvements: string[]
}

export async function gradeEssayAnswer(
  questionText: string,
  modelAnswer: string,
  studentAnswer: string,
  maxPoints: number
): Promise<GradedAnswer> {
  const zai = await getZAI()
  const prompt = `أنت مصحح أكاديمي محترف في ${ACADEMY_INFO.nameAr}. صحح إجابة مقالية لطالب وفق المعايير التالية:

السؤال: ${questionText}

الإجابة النموذجية (المرجع): ${modelAnswer}

إجابة الطالب: ${studentAnswer || '(لم يجب)'}

قواعد التصحيح:
- قيّم من ${maxPoints} نقطة كحد أقصى
- قارن إجابة الطالب بالإجابة النموذجية: الدقة العلمية، الاكتمال، التطبيق العملي
- لا تمنح نقاطاً لإجابة فارغة أو عشوائية غير ذات صلة
- كن منصفاً: إجابة جزئية صحيحة تستحق نقاطاً جزئية
- اكتب تغذية راجعة بنّاءة بالعربية (2-3 جمل): ما أصاب الطالب وما ينقصه وكيف يتحسن

أجب بصيغة JSON فقط بدون أي نص إضافي:
{"points": <رقم من 0 إلى ${maxPoints}>, "feedback": "<التغذية الراجعة بالعربية>"}`

  const raw = await chatWithRetry(zai, [
    { role: 'assistant', content: 'أنت مصحح أكاديمي دقيق يرجع بـ JSON فقط.' },
    { role: 'user', content: prompt },
  ])

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    const points = Math.max(0, Math.min(maxPoints, Number(parsed.points) || 0))
    return {
      index: -1,
      points,
      maxPoints,
      feedback: String(parsed.feedback || '').slice(0, 1500),
    }
  } catch {
    return {
      index: -1,
      points: 0,
      maxPoints,
      feedback: 'تعذر تقييم الإجابة آلياً — سيراجعها المشرف الأكاديمي يدوياً.',
    }
  }
}

export async function generateOverallFeedback(
  programTitle: string,
  percentage: number,
  passed: boolean,
  weakPoints: string[]
): Promise<{ summary: string; strengths: string[]; improvements: string[] }> {
  const zai = await getZAI()
  const prompt = `أنت مشرف أكاديمي في ${ACADEMY_INFO.nameAr}. طالب أنهى اختبار دورة "${programTitle}" بنتيجة ${percentage.toFixed(0)}% (${passed ? 'ناجح' : 'لم يجتز'}).

نقاط الضعف الملاحظة في إجاباته:
${weakPoints.map((w) => `- ${w}`).join('\n') || 'لا توجد نقاط ضعف كبيرة'}

اكتب تقييماً عاماً تحفيزياً وبنّاءً بالعربية بصيغة JSON فقط:
{"summary": "<ملخص الأداء 2-3 جمل>", "strengths": ["<نقطة قوة 1>", "<نقطة قوة 2>"], "improvements": ["<توصية تحسين 1>", "<توصية تحسين 2>"]}`

  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت مشرف أكاديمي يرجع بـ JSON فقط.' },
        { role: 'user', content: prompt },
      ],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    return {
      summary: String(parsed.summary || '').slice(0, 800),
      strengths: (parsed.strengths || []).slice(0, 4).map(String),
      improvements: (parsed.improvements || []).slice(0, 4).map(String),
    }
  } catch {
    return {
      summary: passed
        ? 'مبروك! لقد اجتزت الاختبار بنجاح. استمر في التميز.'
        : 'لم تجتز الاختبار هذه المرة، لكن كل محاولة خطوة نحو الاحتراف. راجع الملاحظات وأعد المحاولة.',
      strengths: ['الالتزام بإكمال الاختبار'],
      improvements: ['مراجعة محتوى الوحدة التدريبية', 'التواصل مع المشرف الذكي لأي استفسار'],
    }
  }
}
