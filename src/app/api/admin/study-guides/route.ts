import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { geminiCompleteJson } from '@/lib/gemini'
import { ensureProgramKnowledge, getProgramKnowledgeItems, cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput, KNOWLEDGE_BANK_LIMITS } from '@/lib/knowledge-bank'
import { conciseAcademicLabel, sanitizeAcademicLabelList, normalizeAcademic } from '@/lib/academic-output-quality'

export const runtime = 'nodejs'
export const maxDuration = 180

type GuideSection = { title: string; summary: string; outcomes?: string[]; sourceTitles?: string[] }

type GeneratedGuide = {
  title: string
  overview: string
  objectives: string[]
  keyTerms: string[]
  sections: GuideSection[]
  activities: string[]
  discussionQuestions: string[]
  sourceKnowledgeIds?: string[]
}

function clean(value: unknown, max = 3000) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function cleanGuideText(value: unknown, fallback: string, max = 3000, allowShort = false) {
  const cleaned = cleanAcademicGeneratedText(value, max)
  return cleaned && !looksLikeBrokenAcademicOutput(cleaned, { allowShort }) ? cleaned : fallback
}

function cleanGuideList(values: unknown, fallback: string[], maxItems: number, maxChars: number) {
  const seen = new Set<string>()
  const out: string[] = []
  const raw = Array.isArray(values) ? values : []
  for (const item of [...raw, ...fallback]) {
    const cleaned = cleanAcademicGeneratedText(item, maxChars)
    const key = cleaned.toLowerCase().replace(/\s+/g, ' ')
    if (!key || seen.has(key) || looksLikeBrokenAcademicOutput(cleaned, { allowShort: true })) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function guideCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    SUMMARY: 'الخلاصة الدراسية',
    CONCEPT: 'المفاهيم المركزية',
    DEFINITION: 'المصطلحات والتعريفات',
    THEORY: 'النظريات والأطر',
    METHOD: 'منهجيات التطبيق',
    CASE: 'الحالات العملية',
    QUESTION_SEED: 'أسئلة المراجعة',
  }
  return labels[String(category || '').toUpperCase()] || 'محور دراسي'
}

function levelLabel(category?: string | null) {
  const c = String(category || '').toUpperCase()
  if (c.includes('DIPLOMA')) return 'الدبلوم المهني'
  if (c.includes('MASTER')) return 'الماجستير المهني'
  if (c.includes('DOCTOR')) return 'الدكتوراه المهنية'
  return 'الدراسات المهنية'
}

function labelIsDisplayable(value: string) {
  const n = normalizeAcademic(value)
  if (!n) return false
  if (/\b(?:concept|theory|method|case|definition|question_seed|summary)\b/i.test(value)) return false
  if (/(?:من النص|من الكتاب|المقطع|الدليل المقروء|مستخرجه من النص|مستخرجة من النص|بذره سؤال|بذرة سؤال|حاله تطبيقيه من|حالة تطبيقية من|بلغه اكاديميه|بلغة أكاديمية|النص وال|المعرفه والامتحان|المعرفة والامتحان)/u.test(n)) return false
  if (/^(?:يحول|يعرض|ينظم|شرح|يربط|ربط|يدرس|يستخدم|يركز|يوضح|يقدم|تحويل|يوظف|يصوغ|يشرح)\b/u.test(n)) return false
  if (/[A-Za-z]{4,}/.test(value) && /[\u0600-\u06FF]/.test(value)) return false
  if (/(?:strategicg|strategicq|logisticg|tacticg)/i.test(value)) return false
  const words = value.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 8 && value.length <= 90 && !looksLikeBrokenAcademicOutput(value, { allowShort: true })
}

function looksLikeWeakGuideText(value: unknown) {
  const raw = cleanAcademicGeneratedText(value, 2600)
  const n = normalizeAcademic(raw)
  if (!raw || !n) return true
  const weak = [
    'يحول هذا العنصر',
    'يعرض هذا العنصر',
    'خلاصه محوريه من النص',
    'خلاصة محورية من النص',
    'الدليل المقروء',
    'الاشاره المعرفيه المستفاده من القراءه',
    'يدرس الطالب هذا المحور بوصفه جزءا',
    'مؤشرات التحقق في الواجب او الامتحان',
    'شرح بلغه اكاديميه واضحه',
    'ربط بحاله مهنيه',
    'محور دراسي منظم يحتاج',
    'لا حفظه مجردا',
  ]
  if (weak.some((x) => n.includes(normalizeAcademic(x)))) return true
  if ((n.match(/محور/g) || []).length >= 6 && raw.length < 1200) return true
  if ((n.match(/المهني/g) || []).length >= 7 && (n.match(/الماجستير/g) || []).length >= 3) return true
  return false
}

function stripGuideBoilerplate(value: unknown, max = 700) {
  let text = cleanAcademicGeneratedText(value, max)
  text = text
    .replace(/^\s*(?:يحوّل|يحول|يعرض|يركز|يلخص|يفتح|يمثل|يضبط|يعالج)\s+هذا\s+(?:العنصر|المحور)[^:：.]{0,260}[:：.]\s*/u, '')
    .replace(/(?:الدليل\s+المقروء|الإشارة\s+المعرفية\s+المستفادة\s+من\s+القراءة)\s*[:：]\s*/u, '')
    .replace(/\s*يدرس\s+الطالب\s+هذا\s+المحور\s+بوصفه\s+جزءاً?.*$/u, '')
    .replace(/\s*المطلوب\s+من\s+الطالب\s+.*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleanAcademicGeneratedText(text, max)
}

function knowledgeEvidenceText(item: any, max = 360) {
  const candidates = [item?.excerpt, item?.summary]
  for (const candidate of candidates) {
    const stripped = stripGuideBoilerplate(candidate, max)
    if (stripped.length >= 50 && !looksLikeWeakGuideText(stripped) && !looksLikeBrokenAcademicOutput(stripped)) return stripped
  }
  return ''
}

function domainTermsForGuide(programTitle: string, knowledge: any[]) {
  const corpus = normalizeAcademic([programTitle, ...knowledge.flatMap((k) => [k?.title, k?.summary, k?.excerpt, ...(Array.isArray(k?.keywords) ? k.keywords : [])])].join(' '))
  const terms: string[] = []
  const add = (term: string) => { if (!terms.some((x) => normalizeAcademic(x) === normalizeAcademic(term))) terms.push(term) }

  if (/استراتيج|strategic|تكتيك|tactic/u.test(corpus)) {
    add('الإدارة الاستراتيجية')
    add('التفكير الاستراتيجي')
    add('القرار الاستراتيجي')
    add('مستويات الاستراتيجية')
    add('الاستراتيجية والتكتيك')
    add('النموذج الذهني الاستراتيجي')
  }
  if (/لوجست|امداد|توريد|موارد|عمليات|logistic/u.test(corpus)) {
    add('اللوجستيات وسلاسل الإمداد')
    add('إدارة الموارد والعمليات')
  }
  if (/حرب|عسكري|عسكرية|ثوره عسكريه|revolution in military/u.test(corpus)) {
    add('المدارس العسكرية الاستراتيجية')
    add('الثورة العسكرية والإدارة')
    add('القيادة وصناعة القرار')
  }
  if (/اداره اعمال|إدارة أعمال|اعمال|منظمه|مؤسسه|مؤسسة|تنافس|سوق/u.test(corpus)) {
    add('تحليل البيئة التنافسية')
    add('الميزة التنافسية')
    add('إدارة المخاطر')
    add('مؤشرات الأداء')
  }
  add('تحليل الحالات')
  add('التطبيق المهني')
  add('التقييم النقدي')
  return terms
}

function sectionRole(category?: string) {
  const c = String(category || '').toUpperCase()
  if (c === 'THEORY') return 'إطاراً تفسيرياً يساعد على قراءة العلاقات والافتراضات وحدود التعميم'
  if (c === 'METHOD') return 'طريقة عمل تنقل الفكرة من التعريف إلى خطوات تشخيص وتحليل وقرار'
  if (c === 'CASE') return 'مدخلاً لبناء حالة مهنية يختبر فيها الطالب القرار والبدائل والمخاطر'
  if (c === 'DEFINITION') return 'مصطلحاً تأسيسياً لا يكتمل فهمه إلا بضبط حدوده وسياق استخدامه'
  if (c === 'QUESTION_SEED') return 'مدخلاً لصياغة أسئلة مراجعة تقيس الفهم والتطبيق لا الحفظ'
  if (c === 'SUMMARY') return 'خريطة مراجعة تربط المفهوم بالأدلة والأسئلة المتوقعة'
  return 'مفهوماً مركزياً يستخدم لفهم محتوى الكتاب وتطبيقه مهنياً'
}

function applicationFrame(programTitle: string) {
  const n = normalizeAcademic(programTitle)
  if (n.includes('اداره اعمال')) return 'تحليل قرارات الأعمال، البيئة التنافسية، توزيع الموارد، المخاطر، ومؤشرات الأداء'
  if (n.includes('مشاريع')) return 'تحليل نطاق المشروع، أصحاب المصلحة، المخاطر، الجدول، والتكلفة'
  if (n.includes('قياده')) return 'تحليل القرار القيادي، التأثير، إدارة الفرق، ونتائج الأداء'
  return 'تحليل حالة مهنية، اختيار بدائل، تبرير القرار، وقياس النتيجة'
}

function analyticalGuideSummary(title: string, item: any, programTitle: string, level: string, semester: number) {
  const role = sectionRole(item?.category)
  const evidence = knowledgeEvidenceText(item, 320)
  const evidenceSentence = evidence ? `تظهر صلته بالمادة المقررة من خلال: ${evidence}.` : 'يرتبط بالمادة المقررة من خلال المفاهيم والأمثلة المحفوظة في بنك المعرفة.'
  const depth = level.includes('الدكتوراه')
    ? 'على الطالب نقد الافتراضات، مقارنة النماذج، وبيان حدود استخدامها البحثية.'
    : level.includes('الماجستير')
      ? 'على الطالب الانتقال من التعريف إلى التحليل والتطبيق، مع تبرير القرار وبيان حدوده.'
      : 'على الطالب فهم الخطوات الأساسية وتطبيقها في مثال مهني مباشر.'
  return cleanGuideText(
    `يتناول هذا المحور «${title}» بوصفه ${role}. ${evidenceSentence} في ${programTitle}، لا يكفي حفظ المصطلح؛ بل يجب توظيفه في ${applicationFrame(programTitle)}. ${depth} يرتبط هذا المحور بالفصل ${semester} لأنه يصلح لبناء واجب تطبيقي أو سؤال امتحاني يقيس الفهم والتحليل.`,
    `يتناول هذا المحور «${title}» بوصفه فكرة مركزية في ${programTitle}، مع ربطها بالتطبيق المهني والواجبات والامتحانات.`,
    1600
  )
}

function outcomesForSection(title: string, programTitle: string, category?: string) {
  const c = String(category || '').toUpperCase()
  const base = [
    `شرح ${title} بلغة دقيقة ومختصرة`,
    `تطبيق ${title} على حالة مهنية في ${programTitle}`,
  ]
  if (c === 'THEORY') base.push('مقارنة الافتراضات وحدود التعميم')
  else if (c === 'METHOD') base.push('تحويل الفكرة إلى خطوات ومؤشرات متابعة')
  else if (c === 'CASE') base.push('تحليل الأطراف والبدائل والمخاطر')
  else base.push('تمييز المعنى عن الحفظ اللفظي')
  return cleanGuideList([], base, 4, 190)
}

function discussionQuestionsFromSections(sections: GuideSection[], programTitle: string) {
  const titles = sections.map((s) => conciseAcademicLabel(s.title, '', 80)).filter(labelIsDisplayable).slice(0, 6)
  const first = titles[0] || 'المحور الرئيس'
  const second = titles[1] || 'المحور الثاني'
  const third = titles[2] || 'المحور الثالث'
  return cleanGuideList([], [
    `كيف يساعد محور «${first}» في تشخيص حالة مهنية داخل ${programTitle}؟`,
    `ما الفرق العملي بين «${first}» و«${second}» عند تحليل قرار إداري أو مهني؟`,
    `ما حدود تطبيق «${third}» عندما تتغير الموارد أو المخاطر أو بيئة العمل؟`,
    `أي مؤشر أداء يثبت أن الطالب فهم «${first}» ولم يكتف بحفظ تعريفه؟`,
    `كيف يمكن تحويل «${second}» إلى واجب تطبيقي أو سؤال امتحاني عادل؟`,
    `ما الخطأ الشائع في استخدام هذه المحاور عند نقلها من الكتاب إلى الواقع المهني؟`,
  ], 8, 340)
}

function cleanGuideQuestionList(values: unknown, fallback: string[], maxItems = 10) {
  const raw = Array.isArray(values) ? values : []
  const seen = new Set<string>()
  const prefixSeen = new Set<string>()
  const out: string[] = []
  for (const item of [...raw, ...fallback]) {
    const cleaned = cleanAcademicGeneratedText(item, 340)
    const key = normalizeAcademic(cleaned)
    const prefix = key.split(' ').slice(0, 4).join(' ')
    if (!key || seen.has(key) || prefixSeen.has(prefix) || looksLikeWeakGuideText(cleaned) || looksLikeBrokenAcademicOutput(cleaned, { allowShort: true })) continue
    seen.add(key)
    prefixSeen.add(prefix)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function sectionIsUseful(section: GuideSection) {
  return !!section.title && !!section.summary && labelIsDisplayable(section.title) && !looksLikeWeakGuideText(section.summary) && !looksLikeBrokenAcademicOutput(`${section.title}. ${section.summary}`)
}

function deriveGuideTerms(knowledge: any[], programTitle: string) {
  const raw: string[] = []
  for (const k of knowledge) {
    const title = conciseAcademicLabel(k?.title || k?.summary || k?.excerpt, '', 80)
    if (title) raw.push(title)
    const evidence = knowledgeEvidenceText(k, 180)
    const fromEvidence = conciseAcademicLabel(evidence, '', 80)
    if (fromEvidence) raw.push(fromEvidence)
    const kws = Array.isArray(k?.keywords) ? k.keywords.map((x: any) => conciseAcademicLabel(x, '', 40)).filter(labelIsDisplayable) : []
    for (let i = 0; i < Math.min(kws.length - 1, 6); i += 2) raw.push(`${kws[i]} و${kws[i + 1]}`)
  }
  const semantic = domainTermsForGuide(programTitle, knowledge)
  const fallback = [
    ...semantic,
    'تحليل الحالات',
    'التطبيق المهني',
    'مؤشرات الأداء',
    'التقييم النقدي',
    'منهجيات التطبيق',
    'قرارات مهنية',
  ]
  return sanitizeAcademicLabelList([...semantic, ...raw], fallback, 14, 72).filter(labelIsDisplayable)
}

function fallbackGuideSections(programTitle: string, semester: number, knowledge: any[]): GuideSection[] {
  const cleanKnowledge = knowledge
    .map((k, i) => ({
      ...k,
      category: String(k?.category || 'CONCEPT').toUpperCase(),
      title: conciseAcademicLabel(k?.title, `محور دراسي ${i + 1}`, 92),
      summary: cleanGuideText(k?.summary, `محور معرفي منظم من الكتب المقررة في ${programTitle}.`, 1800),
    }))
    .filter((k) => labelIsDisplayable(k.title) && k.summary && !looksLikeBrokenAcademicOutput(k.summary))

  const picked: any[] = []
  for (const cat of ['SUMMARY', 'CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'QUESTION_SEED']) {
    const found = cleanKnowledge.find((k) => k.category === cat && !picked.some((p) => p.id === k.id))
    if (found) picked.push(found)
  }
  for (const item of cleanKnowledge) {
    if (picked.length >= 8) break
    if (!picked.some((p) => p.id === item.id || normalizeAcademic(p.title) === normalizeAcademic(item.title))) picked.push(item)
  }

  if (picked.length === 0) {
    return [
      'الخريطة المفاهيمية للبرنامج',
      'الأطر والنظريات الحاكمة',
      'منهجيات التطبيق والتحليل',
      'الحالات المهنية والقرارات',
      'أخطاء الفهم الشائعة',
      'أسئلة المراجعة والامتحان',
    ].map((title) => ({
      title,
      summary: `يعالج هذا المحور جانباً أساسياً في ${programTitle} ويحوّله إلى قراءة منظمة: تعريف الفكرة، تحديد علاقتها بالتخصص، تطبيقها على حالة مهنية، ثم وضع معيار للتحقق في الواجب أو الامتحان.`,
      outcomes: [`شرح ${title}`, `تطبيق ${title} في ${programTitle}`],
      sourceTitles: ['بنك المعرفة الأكاديمي'],
    }))
  }

  return picked.slice(0, 8).map((k, i) => ({
    title: k.title,
    summary: cleanGuideText(
      `${k.summary} يدرس الطالب هذا المحور بوصفه جزءاً من ${programTitle} في الفصل ${semester}، مع التركيز على المعنى، شروط التطبيق، حدود التعميم، ومؤشرات التحقق في الواجب أو الامتحان.`,
      `محور دراسي تطبيقي في ${programTitle}.`,
      1700
    ),
    outcomes: cleanGuideList([], [
      `شرح ${k.title} بلغة أكاديمية واضحة`,
      `ربط ${k.title} بحالة مهنية في ${programTitle}`,
      'تمييز شروط التطبيق وحدود التعميم',
    ], 4, 180),
    sourceTitles: cleanGuideList([], [k.bookTitle || 'بنك المعرفة الأكاديمي'], 4, 160),
  }))
}

function guideLooksStrong(guide: GeneratedGuide) {
  const deepSections = guide.sections.filter((s) => s.summary.length >= 140 && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`))
  return guide.objectives.length >= 3 && guide.keyTerms.length >= 6 && deepSections.length >= 5 && guide.discussionQuestions.length >= 3
}

function asInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function asStatus(value: unknown) {
  const v = String(value || '').trim().toUpperCase()
  return ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(v) ? v : 'PUBLISHED'
}

function jsonArray(value: unknown, fallback: any[] = []) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return fallback
}

function parseJsonObject(raw: string): any | null {
  const body = String(raw || '').trim()
  try { return JSON.parse(body) } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try { return JSON.parse(fenced) } catch {}
  }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) {
    try { return JSON.parse(obj) } catch {}
  }
  return null
}

function normalizeGuide(
  raw: any,
  program: { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null },
  semester: number,
  knowledge: any[]
): GeneratedGuide {
  const programTitle = cleanGuideText(program.titleAr || program.titleEn, 'البرنامج الأكاديمي', 220, true)
  const level = levelLabel(program.category)
  const top = knowledge.slice(0, 28)
  const fallbackSections = fallbackGuideSections(programTitle, semester, top)
  const fallbackTerms = deriveGuideTerms(top, programTitle)
  const semLabel = semester === 2 ? 'الفصل الثاني' : semester === 3 ? 'البحث/المشروع' : 'الفصل الأول'
  const fallbackTitle = `دليل الدراسة التحليلي — ${programTitle} — ${semLabel}`
  const title = cleanGuideText(raw?.title, fallbackTitle, 220, true)
  const overview = cleanGuideText(
    raw?.overview,
    `هذا الدليل يحوّل بنك المعرفة المستخرج من الكتب المقررة في ${programTitle} إلى خطة مذاكرة عملية بمستوى ${level}: مفاهيم مركزية، أطر تفسير، منهجيات تطبيق، حالات مهنية، وأسئلة مراجعة مرتبطة بالواجبات والامتحانات.`,
    5000
  )
  const objectives = cleanGuideList(raw?.objectives, [
    `تحليل محاور ${programTitle} كما ظهرت في الكتب المقررة`,
    'تمييز المفاهيم والتعريفات عن الحالات والأسئلة التطبيقية',
    `ربط المعرفة بمستوى ${level} من حيث العمق والتحليل والنقد`,
    'تحويل القراءة إلى إجابات امتحانية وواجبات قابلة للقياس',
  ], 10, 260)
  const keyTerms = sanitizeAcademicLabelList(jsonArray(raw?.keyTerms), fallbackTerms, 14, 72).filter(labelIsDisplayable)
  const rawSections = jsonArray(raw?.sections)
  const sections = rawSections.map((s: any, i: number) => {
    const fb = fallbackSections[i] || fallbackSections[0] || {
      title: `محور دراسي ${i + 1}`,
      summary: `محور معرفي منظم من الكتب المقررة في ${programTitle}.`,
      outcomes: [`شرح المحور وربطه بسياق ${programTitle}`],
      sourceTitles: ['بنك المعرفة الأكاديمي'],
    }
    return {
      title: conciseAcademicLabel(s?.title, fb.title, 120),
      summary: cleanGuideText(s?.summary, fb.summary, 1800),
      outcomes: cleanGuideList(s?.outcomes, fb.outcomes || [`شرح المحور وربطه بسياق ${programTitle}`], 5, 200),
      sourceTitles: cleanGuideList(s?.sourceTitles, fb.sourceTitles || ['بنك المعرفة الأكاديمي'], 5, 160),
    }
  }).filter((s: GuideSection) => s.title && s.summary && labelIsDisplayable(s.title) && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`)).slice(0, 8)

  const activities = cleanGuideList(raw?.activities, [
    'اختر ثلاثة محاور من الدليل واكتب لكل محور معنى الفكرة، دليلها من الكتاب، وتطبيقها المهني.',
    'حوّل إحدى الحالات أو الأفكار إلى سيناريو مهني مع قرار، بدائل، ومؤشر نجاح.',
    'صمّم بطاقة مراجعة لكل محور: مصطلح، إطار، مثال، سؤال محتمل، ومعيار إجابة.',
  ], 8, 340)
  const discussionQuestions = cleanGuideList(raw?.discussionQuestions, fallbackSections.slice(0, 8).map((s) => `كيف يغيّر محور «${conciseAcademicLabel(s.title, 'هذا المحور', 80)}» طريقة تحليل حالة مهنية في ${programTitle}؟`), 10, 340)

  const guide: GeneratedGuide = {
    title,
    overview,
    objectives,
    keyTerms: keyTerms.length >= 6 ? keyTerms : fallbackTerms,
    sections: sections.length >= 5 ? sections : fallbackSections,
    activities,
    discussionQuestions,
    sourceKnowledgeIds: Array.isArray(raw?.sourceKnowledgeIds) ? raw.sourceKnowledgeIds.map((x: any) => clean(x, 80)).filter(Boolean).slice(0, 60) : top.map((k: any) => k.id).filter(Boolean),
  }

  if (guideLooksStrong(guide)) return guide
  return {
    ...guide,
    keyTerms: fallbackTerms,
    sections: fallbackSections.length ? fallbackSections : guide.sections,
    discussionQuestions: guide.discussionQuestions.length >= 3 ? guide.discussionQuestions : cleanGuideList([], fallbackSections.slice(0, 6).map((s) => `ما شروط تطبيق محور «${conciseAcademicLabel(s.title, 'هذا المحور', 80)}» وما حدوده في ${programTitle}؟`), 8, 340),
  }
}

async function generateStudyGuide(programId: string, semester: number): Promise<GeneratedGuide> {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true, category: true, description: true } })
  if (!program) throw new Error('البرنامج غير موجود')

  const knowledgeSemester = semester === 3 ? null : semester
  await ensureProgramKnowledge(programId, knowledgeSemester, KNOWLEDGE_BANK_LIMITS.minContextItems).catch(() => null)
  const knowledge = await getProgramKnowledgeItems(programId, knowledgeSemester, 80)
  if (!knowledge.length) throw new Error('لا يوجد بنك معرفة كافٍ لتوليد دليل دراسة. أضف كتباً أو ابنِ بنك المعرفة أولاً.')

  const context = knowledge.slice(0, 56).map((k, i) => {
    const title = conciseAcademicLabel(k.title, `محور ${i + 1}`, 90)
    const source = k.bookTitle ? ` — من كتاب ${cleanGuideText(k.bookTitle, 'الكتاب المقرر', 120, true)}` : ''
    const evidence = k.excerpt ? ` — دليل/إشارة: ${cleanGuideText(k.excerpt, '', 240)}` : ''
    return `${i + 1}. [${guideCategoryLabel(k.category)}] ${title}. ${cleanGuideText(k.summary, '', 460)}${evidence}${source}`
  }).join('\n')

  const guidePrompt = `أنشئ دليل دراسة عربي رسمي ومهني من بنك المعرفة التالي.

البرنامج: ${program.titleAr}
التصنيف: ${program.category}
الفصل: ${semester === 2 ? 'الثاني' : semester === 3 ? 'البحث/المشروع' : 'الأول'}
وصف البرنامج: ${program.description || '-'}

محتوى منظم من الكتب المقررة:
${context}

المطلوب JSON object فقط بهذه الحقول:
{
  "title": "عنوان الدليل",
  "overview": "مقدمة تعليمية واضحة",
  "objectives": ["هدف تعلم"],
  "keyTerms": ["مصطلح"],
  "sections": [{"title":"محور", "summary":"شرح تفصيلي من محتوى الكتب", "outcomes":["مخرج"], "sourceTitles":["مصدر/كتاب"]}],
  "activities": ["نشاط قراءة أو تطبيق"],
  "discussionQuestions": ["سؤال نقاش للمشرف الذكي أو المحاضر"],
  "sourceKnowledgeIds": ["id إن وجد"]
}

الشروط:
- الدليل يجب أن يكون من محتوى الكتب وبنك المعرفة، لا كلاماً عاماً ولا شعارات.
- اجعل البنية مناسبة للتخصص الحقيقي والدرجة: الدبلوم عملي، الماجستير تحليلي تطبيقي، الدكتوراه نقدي بحثي.
- keyTerms يجب أن تكون 8-14 مصطلحاً/محوراً قصيراً من كلمتين إلى أربع كلمات مثل «تحليل المخاطر» أو «القرار الاستراتيجي»، وليست جملاً طويلة ولا عناوين تبدأ بـ «حالة تطبيقية» أو «منهجية».
- sections يجب أن تكون 6-8 محاور دراسية مرتبة: مفهوم/تعريف، إطار أو نظرية، منهجية، حالة تطبيقية، سؤال مراجعة، وخلاصة امتحانية عند توفرها.
- كل section.summary يجب أن يشرح: معنى المحور، لماذا هو مهم للدرجة، كيف يطبّق في التخصص، وما الخطأ الشائع في فهمه.
- لا تستخدم رموزاً تقنية مثل CONCEPT أو QUESTION_SEED أو عبارات داخلية مثل «من النص» و«مستخرجة من النص».
- لا تستخدم Markdown أو ** داخل أي حقل.
- لا تنقل أي جملة تبدو OCR مشوهة أو مختلطة اللغات، مثل أسماء كتب أجنبية داخل جملة عربية أو سنوات غير منطقية 8121/8115/8518.
- إذا كان المصدر مشوشاً، أعد صياغة المعنى الأكاديمي المفهوم فقط أو تجاهل المقطع.
- لا تكتفِ بعناوين عامة؛ كل محور يجب أن يستند إلى عنصر معرفة محدد ظاهر في السياق ويُصاغ كدليل دراسة مفهوم للطالب.`

  try {
    const raw = await Promise.race([
      geminiCompleteJson({
        system: 'أنت مصمم دليل دراسة جامعي مهني. أعد JSON object صالحاً فقط دون Markdown.',
        history: [{ role: 'user', text: guidePrompt }],
        temperature: 0.12,
        maxOutputTokens: 8192,
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('STUDY_GUIDE_GEMINI_TIMEOUT')), 38000)),
    ])
    const parsed = parseJsonObject(raw)
    return normalizeGuide(parsed || {}, program, semester, knowledge)
  } catch (e: any) {
    console.error('study guide Gemini fallback:', String(e?.message || e).slice(0, 300))
  }

  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت مصمم دليل دراسة جامعي مهني. أعد JSON صالحاً فقط دون Markdown.' },
        { role: 'user', content: guidePrompt },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('STUDY_GUIDE_ZAI_TIMEOUT')), 30000)),
    ])
    const parsed = parseJsonObject(raw)
    return normalizeGuide(parsed || {}, program, semester, knowledge)
  } catch (e: any) {
    console.error('study guide AI fallback:', String(e?.message || e).slice(0, 300))
    return normalizeGuide({}, program, semester, knowledge)
  }
}

function mapGuide(g: any) {
  const rawSections = jsonArray(g.sections)
  const keyTermsFromStored = sanitizeAcademicLabelList(jsonArray(g.keyTerms), [], 14, 72).filter(labelIsDisplayable)
  const keyTermsFromSections = sanitizeAcademicLabelList(rawSections.map((s: any) => s?.title), [], 14, 72).filter(labelIsDisplayable)
  const keyTerms = keyTermsFromStored.length ? keyTermsFromStored : keyTermsFromSections
  const sections = rawSections.map((s: any, i: number) => ({
    title: conciseAcademicLabel(s?.title, keyTerms[i] || `محور دراسي ${i + 1}`, 120),
    summary: cleanGuideText(s?.summary, 'محور دراسي منظم من الكتب المقررة.', 1600),
    outcomes: cleanGuideList(s?.outcomes, ['فهم المحور وربطه بالتطبيق المهني'], 5, 180),
    sourceTitles: cleanGuideList(s?.sourceTitles, ['بنك المعرفة'], 5, 160),
  })).filter((s: GuideSection) => s.title && s.summary && labelIsDisplayable(s.title) && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`))
  const safeSections = sections.length ? sections : keyTerms.slice(0, 6).map((term) => ({
    title: term,
    summary: `محور دراسي منظم يحتاج إلى ربطه بمحتوى الكتب المقررة والتطبيق المهني قبل الامتحان.`,
    outcomes: ['شرح المحور بلغة واضحة', 'ربطه بحالة مهنية أو سؤال امتحاني'],
    sourceTitles: ['بنك المعرفة'],
  }))
  return {
    id: g.id,
    programId: g.programId,
    semester: g.semester,
    title: cleanGuideText(g.title, 'دليل الدراسة', 220, true),
    overview: cleanGuideText(g.overview, 'دليل دراسة منظم يربط الكتب المقررة بالتطبيق المهني والاختبارات.', 7000),
    objectives: cleanGuideList(jsonArray(g.objectives), ['فهم محاور الدليل', 'ربط المعرفة بالتطبيق المهني'], 10, 220),
    keyTerms,
    sections: safeSections,
    activities: cleanGuideList(jsonArray(g.activities), ['قراءة المحاور ثم كتابة ملخص تطبيقي قصير.'], 8, 300),
    discussionQuestions: cleanGuideList(jsonArray(g.discussionQuestions), ['كيف تربط محتوى الدليل بحالة مهنية واقعية؟'], 10, 320),
    sourceKnowledgeIds: jsonArray(g.sourceKnowledgeIds),
    status: g.status,
    generatedBy: g.generatedBy,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId') || ''
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const guides = await db.programStudyGuide.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }] })
    return NextResponse.json({ guides: guides.map(mapGuide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = asInt(body.semester, 1, 1, 3)
    const status = asStatus(body.status)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const generated = await generateStudyGuide(programId, semester)
    const guide = await db.programStudyGuide.upsert({
      where: { programId_semester: { programId, semester } },
      update: {
        title: generated.title,
        overview: generated.overview,
        objectives: JSON.stringify(generated.objectives),
        keyTerms: JSON.stringify(generated.keyTerms),
        sections: JSON.stringify(generated.sections),
        activities: JSON.stringify(generated.activities),
        discussionQuestions: JSON.stringify(generated.discussionQuestions),
        sourceKnowledgeIds: JSON.stringify(generated.sourceKnowledgeIds || []),
        status,
        generatedBy: 'AI',
      },
      create: {
        programId,
        semester,
        title: generated.title,
        overview: generated.overview,
        objectives: JSON.stringify(generated.objectives),
        keyTerms: JSON.stringify(generated.keyTerms),
        sections: JSON.stringify(generated.sections),
        activities: JSON.stringify(generated.activities),
        discussionQuestions: JSON.stringify(generated.discussionQuestions),
        sourceKnowledgeIds: JSON.stringify(generated.sourceKnowledgeIds || []),
        status,
        generatedBy: 'AI',
      },
    })

    await audit(admin, 'GENERATE_STUDY_GUIDE', 'ProgramStudyGuide', guide.id, `توليد دليل دراسة للفصل ${semester}: ${guide.title}`)
    if (status === 'PUBLISHED') {
      const enrollments = await db.enrollment.findMany({ where: { programId, status: 'ACTIVE' }, select: { userId: true } })
      await Promise.all(enrollments.map((e) => notify(e.userId, 'GENERAL', 'دليل دراسة جديد', `تم نشر دليل دراسة جديد: ${guide.title}`, 'dashboard')))
    }

    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر توليد دليل الدراسة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = clean(body.id, 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const data: any = {}
    if (body.title != null) data.title = clean(body.title, 220)
    if (body.overview != null) data.overview = clean(body.overview, 7000)
    if (body.status != null) data.status = asStatus(body.status)
    if (body.objectives != null) data.objectives = JSON.stringify(jsonArray(body.objectives).map((x) => clean(x, 220)).filter(Boolean))
    if (body.keyTerms != null) data.keyTerms = JSON.stringify(jsonArray(body.keyTerms).map((x) => clean(x, 90)).filter(Boolean))
    if (body.activities != null) data.activities = JSON.stringify(jsonArray(body.activities).map((x) => clean(x, 300)).filter(Boolean))
    if (body.discussionQuestions != null) data.discussionQuestions = JSON.stringify(jsonArray(body.discussionQuestions).map((x) => clean(x, 320)).filter(Boolean))

    const guide = await db.programStudyGuide.update({ where: { id }, data })
    await audit(admin, 'UPDATE_STUDY_GUIDE', 'ProgramStudyGuide', guide.id, `تعديل دليل دراسة: ${guide.title}`)
    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث دليل الدراسة' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const existing = await db.programStudyGuide.findUnique({ where: { id }, select: { title: true } })
    await db.programStudyGuide.delete({ where: { id } })
    await audit(admin, 'DELETE_STUDY_GUIDE', 'ProgramStudyGuide', id, `حذف دليل دراسة: ${existing?.title || id}`)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف دليل الدراسة' }, { status: 500 })
  }
}
