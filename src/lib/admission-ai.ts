import { db } from '@/lib/db'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { readDocumentImage, DOC_TYPE_AR, type ImageDocRead } from '@/lib/ocr'

// ===== قواعد القبول المخصصة لكل برنامج (تضبطها الإدارة من لوحة الإدارة) =====
export interface AdmissionRules {
  minEducation?: 'HIGH_SCHOOL' | 'BACHELOR' | 'MASTER' | 'NONE' // الحد الأدنى للمؤهل المعلن
  requireMasterForDoctorate?: boolean // إلزام ماجستير للدكتوراة (أو السماح بمعادلة الخبرات)
  allowExperienceEquivalency?: boolean // السماح بمعادلة الخبرات بدل المؤهل
  minYearsExperience?: number // الحد الأدنى لسنوات الخبرة عند معادلة الخبرات
  requiredDocuments?: string[] // الوثائق الإلزامية (DEGREE/ID/PHOTO/CV أو غيرها)
  minAge?: number // الحد الأدنى للعمر
  customRules?: string // نص حر بقواعد إضافية تضبطها الإدارة وتقرأه ذكاء القبول حرفياً
  displayNote?: string // ملاحظة تُعرض للمتقدمين في نموذج الالتحاق
}

export const DEFAULT_REQUIRED_DOCS = ['DEGREE', 'ID', 'PHOTO', 'CV']

const EDU_RANK: Record<string, number> = { NONE: 0, OTHER: 0, HIGH_SCHOOL: 1, BACHELOR: 2, MASTER: 3 }

/** قواعد البرنامج المخصصة أو الافتراضية وفق درجته */
export function resolveRules(category: string, raw: unknown): AdmissionRules {
  let r: AdmissionRules = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) r = raw as AdmissionRules
  const def: AdmissionRules = {}
  if (category === 'DOCTORATE') {
    def.minEducation = 'BACHELOR'
    def.requireMasterForDoctorate = true
    def.allowExperienceEquivalency = true
    def.minYearsExperience = 8
    def.minAge = 24
  } else if (category === 'MASTERS') {
    def.minEducation = 'BACHELOR'
    def.minAge = 20
  } else {
    def.minEducation = 'HIGH_SCHOOL'
    def.minAge = 16
  }
  def.requiredDocuments = DEFAULT_REQUIRED_DOCS
  return { ...def, ...r, requiredDocuments: r.requiredDocuments?.length ? r.requiredDocuments : def.requiredDocuments }
}

// ===== خبير القبول الذكي: تحليل طلبات الالتحاق قبل قرار الإدارة =====
// يقارن مدخلات الطالب ومرفقاته بمتطلبات البرنامج (شهادة الثانوية للدبلوم،
// البكالوريوس للماجستير، الماجستير المهني أو الأكاديمي للدكتوراة) ويفحص منطقية البيانات،
// ثم يضع ملاحظاته وتقييمه للإدارة قبل زر الاعتماد.

export type Verdict = 'RECOMMEND_APPROVE' | 'NEEDS_CLARIFICATION' | 'RECOMMEND_REJECT' | 'INSUFFICIENT_DATA'

export interface ChecklistItem {
  requirement: string
  status: 'FOUND' | 'MISSING' | 'UNVERIFIED' | 'PROBLEM'
  detail: string
}

export interface Finding {
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  title: string
  detail: string
}

export interface AdmissionAIReview {
  verdict: Verdict
  fitScore: number
  summaryForAdmin: string
  checklist: ChecklistItem[]
  findings: Finding[]
  strengths: string[]
  recommendedAction: string
  engine: 'AI+RULES' | 'RULES_ONLY'
  analyzedAt: string
}

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 دقيقة

const CATEGORY_AR: Record<string, string> = {
  DOCTORATE: 'الدكتوراه المهنية',
  MASTERS: 'الماجستير المهني',
  DIPLOMA: 'الدبلوم المهني',
  ACCREDITATION: 'الاعتماد الدولي',
}

const EDUCATION_AR: Record<string, string> = {
  HIGH_SCHOOL: 'الثانوية العامة',
  BACHELOR: 'البكالوريوس',
  MASTER: 'الماجستير (مهني أو أكاديمي)',
  OTHER: 'مؤهل آخر',
}

/** استخراج نص من ملف PDF (أول 3500 حرف) لفحص محتوى المستند */
async function extractPdfSnippet(buffer: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return (result?.text || '').replace(/\s+/g, ' ').trim().slice(0, 3500)
    } finally {
      await parser.destroy().catch(() => {})
    }
  } catch {
    return ''
  }
}

export const EDU_LABEL = EDUCATION_AR

/** كلمات دلالية للتحقق من نوع الشهادة داخل نص المستند أو اسم الملف */
const KEYWORDS = {
  highSchool: ['ثانوية', 'الثانوية', 'الشهادة الثانوية', 'high school', 'secondary school', 'ثانوي'],
  bachelor: ['بكالوريوس', 'بكلوريوس', 'بكلاريوس', 'إجازة', 'الليسانس', 'ليسانس', 'bachelor', 'b.sc', 'bsc', 'b.a'],
  master: ['ماجستير', 'ماجستير', 'master', 'm.sc', 'msc', 'm.a', 'mba', 'إمبائي'],
}

function matchKeywords(haystack: string, list: string[]): string | null {
  const h = haystack.toLowerCase()
  for (const kw of list) {
    if (h.includes(kw.toLowerCase())) return kw
  }
  return null
}

/** الحكم النهائي: الأسوأ بين حكمين (قواعد vs ذكاء اصطناعي) */
function worseVerdict(a: Verdict, b: Verdict): Verdict {
  const order: Verdict[] = ['RECOMMEND_APPROVE', 'INSUFFICIENT_DATA', 'NEEDS_CLARIFICATION', 'RECOMMEND_REJECT']
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

const VERDICT_AR: Record<Verdict, string> = {
  RECOMMEND_APPROVE: 'يوصى بالاعتماد',
  NEEDS_CLARIFICATION: 'ملاحظات تحتاج مراجعة قبل الاعتماد',
  RECOMMEND_REJECT: 'يوصى بمراجعة جدية قبل الاعتماد — نواقص جوهرية',
  INSUFFICIENT_DATA: 'بيانات غير كافية للتحليل — اطلب استكمال الملف',
}

/** قواعد المقارنة الحتمية: متطلبات البرنامج (المخصصة أو الافتراضية) ومطابقتها مع ما قدمه الطالب */
function runRules(app: {
  fullName: string
  education: string
  program: string
  programCategory: string
  nationalId?: string | null
  birthDate?: Date | null
  country?: string | null
  rules: AdmissionRules // قواعد البرنامج (مخصصة أو افتراضية)
  files: { docType: string; fileName: string; mimeType: string; size: number; textSnippet: string; ocrRead?: ImageDocRead | null }[]
}): { checklist: ChecklistItem[]; findings: Finding[]; hardProblems: number; docTextFound: boolean } {
  const rules = app.rules
  const checklist: ChecklistItem[] = []
  const findings: Finding[] = []
  let hardProblems = 0
  let docTextFound = false

  const byType = new Map<string, { fileName: string; mimeType: string; size: number; textSnippet: string; ocrRead?: ImageDocRead | null }>()
  for (const f of app.files) if (!byType.has(f.docType)) byType.set(f.docType, f)

  // 1) المستندات الإلزامية — من قواعد البرنامج (قابلة للتخصيص من الإدارة)
  const reqDocs = rules.requiredDocuments || DEFAULT_REQUIRED_DOCS
  for (const type of reqDocs) {
    const label = DOC_TYPE_AR[type] || type
    const f = byType.get(type)
    if (!f) {
      checklist.push({ requirement: label, status: 'MISSING', detail: 'لم يُرفع هذا المستند (مطلوب وفق قواعد قبول البرنامج)' })
      hardProblems++
    } else {
      // قراءة PDF نصياً أو قراءة الصورة بالذكاء الاصطناعي (Vision OCR)
      const pdfReadable = f.mimeType.includes('pdf') && f.textSnippet.length > 40
      const isPortrait = type === 'PHOTO'
      const imgReadable = !!f.ocrRead?.readable && (!!f.ocrRead?.extractedText || isPortrait)
      const readable = pdfReadable || imgReadable
      if (readable) docTextFound = true
      let detail: string
      if (pdfReadable) {
        detail = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب) وتمت قراءة محتواه النصي آلياً`
      } else if (imgReadable && isPortrait) {
        const o = f.ocrRead!
        detail = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب) — فحصها الذكاء الاصطناعي: ${o.docTypeDetected || 'صورة شخصية'} واضحة${o.qualityNote ? ` — ${o.qualityNote}` : ''}`
      } else if (imgReadable) {
        const o = f.ocrRead!
        detail = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب) — قُرأت الصورة بالذكاء الاصطناعي: ${o.docTypeDetected || 'مستند'}`
        if (o.degreeMentioned === 'BACHELOR' || o.degreeMentioned === 'MASTER' || o.degreeMentioned === 'HIGH_SCHOOL') {
          detail += ` — وردت درجة ${EDUCATION_AR[o.degreeMentioned] || o.degreeMentioned}`
        }
        if (o.nameOnDoc) detail += ` — الاسم عليها: «${o.nameOnDoc}»`
        if (o.qualityNote) detail += ` — ${o.qualityNote}`
        if (o.matchNote) detail += ` — ${o.matchNote}`
      } else {
        detail = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب) — ${f.mimeType.includes('pdf') ? 'محتوى غير قابل للقراءة الآلية' : 'تعذر قراءة الصورة آلياً — يُنصح بمعاينتها يدوياً'}`
      }
      // تعارض نوع المستند: الطالب صنّفه X لكن الصورة تظهر غير ذلك
      if (imgReadable && f.ocrRead!.docTypeDetected && type === 'DEGREE') {
        const dt = f.ocrRead!.docTypeDetected
        if (/هوية|جواز|صورة شخصية|سيرة/.test(dt)) {
          checklist.push({ requirement: `مطابقة نوع المستند للتصنيف`, status: 'PROBLEM', detail: `صُنّف الملف «${label}» لكن ما يظهر في الصورة يوحي بأنه ${dt} — تأكد من رفع المستند الصحيح` })
        }
      }
      checklist.push({ requirement: label, status: readable ? 'FOUND' : 'UNVERIFIED', detail })
    }
  }

  // 2) مطابقة المؤهل مع متطلبات البرنامج — بحسب الحد الأدنى في قواعد البرنامج
  const degreeDoc = byType.get('DEGREE')
  const degreeHaystack = degreeDoc ? `${degreeDoc.fileName} ${degreeDoc.textSnippet} ${degreeDoc.ocrRead?.extractedText || ''}` : ''
  const cat = app.programCategory
  const eduRank = EDU_RANK[app.education] ?? 0
  const minRank = EDU_RANK[rules.minEducation || 'HIGH_SCHOOL'] ?? 1
  const MIN_LABEL = EDUCATION_AR[rules.minEducation || 'HIGH_SCHOOL'] || rules.minEducation || 'الثانوية'

  // قراءة درجة الشهادة من الصورة نفسها (Vision OCR) إن وُجدت
  const ocrDegree = degreeDoc?.ocrRead?.readable ? degreeDoc.ocrRead.degreeMentioned : 'NONE'
  const ocrDegreeRank = EDU_RANK[ocrDegree] ?? 0

  if (cat === 'DOCTORATE' && rules.requireMasterForDoctorate) {
    const declaredOK = app.education === 'MASTER'
    checklist.push({
      requirement: 'المؤهل المطلوب للدكتوراة: ماجستير مهني أو أكاديمي' + (rules.allowExperienceEquivalency ? ' (أو معادلة خبرات وفق قواعد البرنامج)' : ''),
      status: declaredOK ? 'FOUND' : app.education === 'BACHELOR' ? (rules.allowExperienceEquivalency ? 'UNVERIFIED' : 'PROBLEM') : 'PROBLEM',
      detail: declaredOK
        ? 'الطالب أعلن حيازة ماجستير'
        : app.education === 'BACHELOR'
          ? rules.allowExperienceEquivalency
            ? `أعلن بكالوريوس فقط — تقبل معادلة خبرات وفق قواعد البرنامج${rules.minYearsExperience ? ` بحد أدنى ${rules.minYearsExperience} سنوات خبرة` : ''}، يرجى التحقق من الخبرات`
            : 'أعلن بكالوريوس فقط — قواعد البرنامج لا تسمح بمعادلة الخبرات، الماجستير إلزامي'
          : `أعلن: ${EDUCATION_AR[app.education] || app.education} — أقل من المطلوب للدكتوراة`,
    })
    if (!declaredOK && app.education === 'BACHELOR' && !rules.allowExperienceEquivalency) hardProblems++
    // فحص نص/صورة شهادة الدراسات العليا
    if (degreeDoc && (degreeHaystack.trim() || ocrDegree !== 'NONE')) {
      const kw = matchKeywords(degreeHaystack, KEYWORDS.master)
      if (kw) {
        checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'FOUND', detail: `ورد في المستند دليل على درجة دراسات عليا («${kw}»)` })
      } else if (ocrDegree === 'BACHELOR') {
        checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'PROBLEM', detail: `قرأ الذكاء الاصطناعي صورة الشهادة المرفقة ووجد أنها «بكالوريوس» — لا توجد شهادة ماجستير ضمن المرفقات، وهو مطلوب للدكتوراة وفق قواعد البرنامج` })
        hardProblems++
      } else if (kw === null && (matchKeywords(degreeHaystack, KEYWORDS.bachelor) || ocrDegreeRank > 0) && ocrDegree !== 'MASTER') {
        checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'UNVERIFIED', detail: 'لم يُعثر على دليل ماجستير في المستندات — قد تكون الشهادة المتحقة أقل من المطلوب' })
      } else if (degreeDoc.textSnippet.length > 40 || ocrDegree === 'NONE') {
        checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'UNVERIFIED', detail: 'لم يتضح من المستندات وجود ماجستير — يرجى المعاينة أو طلب الشهادة' })
      }
    } else if (!degreeDoc) {
      checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'MISSING', detail: 'لم يُرفع أي مستند شهادة لإثبات الماجستير' })
    }
  } else {
    // ماجستير / دبلوم / برامج أخرى: الحد الأدنى من قواعد البرنامج
    const ok = eduRank >= minRank
    checklist.push({
      requirement: `المؤهل المطلوب: ${MIN_LABEL} على الأقل${cat === 'MASTERS' ? ' (لقبول الماجستير)' : cat === 'DIPLOMA' ? ' (لقبول الدبلوم)' : ''}`,
      status: ok ? 'FOUND' : 'PROBLEM',
      detail: ok ? `أعلن: ${EDUCATION_AR[app.education] || app.education}` : `أعلن: ${EDUCATION_AR[app.education] || app.education} — الحد الأدنى وفق قواعد البرنامج هو ${MIN_LABEL}`,
    })
    if (!ok) hardProblems++
    // التحقق من نص/صورة الشهادة
    if (degreeDoc && (degreeHaystack.trim() || ocrDegree !== 'NONE')) {
      const kw = matchKeywords(degreeHaystack, KEYWORDS.highSchool) || matchKeywords(degreeHaystack, KEYWORDS.bachelor) || matchKeywords(degreeHaystack, KEYWORDS.master)
      if (kw) {
        checklist.push({ requirement: 'التحقق من نص/صورة الشهادة', status: 'FOUND', detail: `ورد في المستند «${kw}»` })
      } else if (ocrDegree !== 'NONE' && ocrDegree !== 'OTHER') {
        const matches = ocrDegreeRank >= minRank
        checklist.push({ requirement: 'التحقق من نص/صورة الشهادة', status: matches ? 'FOUND' : 'PROBLEM', detail: matches ? `قرأ الذكاء الاصطناعي صورة الشهادة ووجد درجة ${EDUCATION_AR[ocrDegree] || ocrDegree} — مستوفية للحد الأدنى` : `قرأ الذكاء الاصطناعي صورة الشهادة ووجد درجة ${EDUCATION_AR[ocrDegree] || ocrDegree} — أقل من الحد الأدنى المطلوب (${MIN_LABEL})` })
        if (!matches) hardProblems++
      } else if (degreeDoc.textSnippet.length > 40) {
        checklist.push({ requirement: 'التحقق من نص/صورة الشهادة', status: 'PROBLEM', detail: 'نص المستند قابل للقراءة لكنه لا يذكر المؤهل المطلوب' })
      }
    }
  }

  // 3) منطقية البيانات: العمر مقابل المؤهل المعلن — بحد أدنى من قواعد البرنامج
  const minAge = rules.minAge || 16
  if (app.birthDate) {
    const age = (Date.now() - new Date(app.birthDate).getTime()) / (365.25 * 24 * 3600 * 1000)
    const ageR = Math.floor(age)
    if (ageR < minAge) {
      findings.push({ severity: 'HIGH', title: 'العمر أقل من الحد الأدنى وفق قواعد البرنامج', detail: `العمر ${ageR} سنة والحد الأدنى المحدد لقبول هذا البرنامج ${minAge} سنة — تاريخ الميلاد ${new Date(app.birthDate).toLocaleDateString('ar-EG')}` })
      hardProblems++
    } else if (app.education === 'MASTER' && ageR < 22) {
      findings.push({ severity: 'HIGH', title: 'تناقض العمر مع المؤهل', detail: `العمر ${ageR} سنة مع إعلان ماجستير — غير منطقي زمنياً (ماجستير لا يُنجز عادة قبل 22-24 سنة)` })
      hardProblems++
    } else if (app.education === 'BACHELOR' && ageR < 18) {
      findings.push({ severity: 'HIGH', title: 'تناقض العمر مع المؤهل', detail: `العمر ${ageR} سنة مع إعلان بكالوريوس — غير منطقي زمنياً` })
      hardProblems++
    }
  }

  // 4) مطابقة اسم الطالب مع الاسم على المستندات (إن قرأ الذكاء الصورة)
  // نتجاهل اختلاف الحروف العربية/اللاتينية (ترجمة الاسم طبيعية) وننبّه فقط عند اختلاف واضح بنفس نظام الكتابة
  const ocrName = app.files.find((f) => f.ocrRead?.readable && f.ocrRead.nameOnDoc)?.ocrRead?.nameOnDoc
  if (ocrName && app.fullName) {
    const sameScript = (s: string) => /[\u0600-\u06ff]/.test(s) ? 'ar' : /[a-z]/i.test(s) ? 'en' : 'other'
    if (sameScript(app.fullName) === sameScript(ocrName)) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z\u0600-\u06ff]/g, '')
      const a = norm(app.fullName)
      const b = norm(ocrName)
      const words = (x: string) => x.split(' ').filter((w) => w.length > 1)
      const shared = words(a).filter((w) => b.includes(w)).length
      if (a && b && a !== b && shared < Math.min(words(a).length, words(b).length) / 2) {
        findings.push({ severity: 'MEDIUM', title: 'اختلاف الاسم مع المستند', detail: `الاسم المعلن «${app.fullName}» يختلف كثيراً عن الاسم الظاهر على المستند المقروء آلياً «${ocrName}» — يُنصح بالتحقق` })
      }
    }
  }

  if (!app.nationalId?.trim()) {
    findings.push({ severity: 'MEDIUM', title: 'رقم الهوية/الجواز غير مذكور', detail: 'حقل الهوية فارغ رغم كونه إلزامياً' })
  }

  return { checklist, findings, hardProblems, docTextFound }
}

/** التحليل الذكي الكامل لطلب التحاق — مع تخزين مؤقت وإعادة تحليل اختيارية */
export async function analyzeAdmission(
  admissionId: string,
  opts?: { force?: boolean }
): Promise<{ review: AdmissionAIReview; cached: boolean }> {
  const app = await db.admissionApplication.findUnique({
    where: { id: admissionId },
    include: {
      programRef: { select: { titleAr: true, category: true, admissionRules: true } },
      files: { select: { id: true, docType: true, fileName: true, mimeType: true, size: true, data: true } },
    },
  })
  if (!app) throw new Error('الطلب غير موجود')

  // كاش: تحليل حديث خلال 30 دقيقة
  if (!opts?.force && app.aiReview && app.aiReviewedAt && Date.now() - new Date(app.aiReviewedAt).getTime() < CACHE_TTL_MS) {
    try {
      return { review: JSON.parse(app.aiReview) as AdmissionAIReview, cached: true }
    } catch { /* تحليل تالف — أعد التوليد */ }
  }

  // قواعد القبول المخصصة لهذا البرنامج (تضبطها الإدارة) أو الافتراضية وفق درجته
  const programRules = resolveRules(app.programRef?.category || 'DIPLOMA', app.programRef?.admissionRules)

  // استخراج نصوص مستندات PDF + قراءة صور المستندات بالذكاء الاصطناعي (حتى 4 أدلة)
  const files = [] as { docType: string; fileName: string; mimeType: string; size: number; textSnippet: string; ocrRead?: ImageDocRead | null }[]
  let evidenceCount = 0
  for (const f of app.files) {
    let textSnippet = ''
    let ocrRead: ImageDocRead | null = null
    if (f.mimeType.includes('pdf') && f.data && evidenceCount < 4) {
      evidenceCount++
      textSnippet = await extractPdfSnippet(Buffer.from(f.data, 'base64'))
    } else if (f.mimeType.startsWith('image/') && f.data && evidenceCount < 4) {
      // الصور تُقرأ الآن فعلياً بالذكاء الاصطناعي (Vision OCR)
      evidenceCount++
      ocrRead = await readDocumentImage(Buffer.from(f.data, 'base64'), f.mimeType, f.docType, DOC_TYPE_AR[f.docType] || f.docType)
    }
    files.push({ docType: f.docType, fileName: f.fileName, mimeType: f.mimeType, size: f.size, textSnippet, ocrRead })
  }

  const rules = runRules({
    fullName: app.fullName,
    education: app.education,
    program: app.program,
    programCategory: app.programRef?.category || 'DIPLOMA',
    nationalId: app.nationalId,
    birthDate: app.birthDate,
    country: app.country,
    rules: programRules,
    files,
  })

  // ===== طبقة الذكاء الاصطناعي: تقييم استشاري مبني على الأدلة =====
  const cat = app.programRef?.category || 'DIPLOMA'
  const level = CATEGORY_AR[cat] || cat
  const ocrEvidence = files
    .filter((f) => f.ocrRead?.readable)
    .map((f) => {
      const o = f.ocrRead!
      return `[${f.docType} — ${f.fileName}] قراءة صورة بالذكاء الاصطناعي: النوع=${o.docTypeDetected}؛ الدرجة=${o.degreeMentioned}؛ الاسم=${o.nameOnDoc || '-'}؛ الجهة=${o.institution || '-'}؛ التاريخ=${o.issueDate || '-'}؛ النص المستخرج: ${o.extractedText.slice(0, 800)}`
    })
  const evidence = [
    `اسم المتقدم: ${app.fullName}`,
    `البرنامج المتقدم له: ${app.program} (${level})`,
    `المؤهل المعلن: ${EDUCATION_AR[app.education] || app.education}`,
    `الدولة: ${app.country || '-'} — الهوية: ${app.nationalId || 'غير مذكورة'}`,
    app.birthDate ? `تاريخ الميلاد: ${new Date(app.birthDate).toLocaleDateString('ar-EG')} (العمر ${Math.floor((Date.now() - new Date(app.birthDate).getTime()) / (365.25 * 24 * 3600 * 1000))} سنة)` : 'تاريخ الميلاد: غير مذكور',
    `المستندات المرفوعة (${app.files.length}): ${app.files.map((f) => `${f.docType}(${f.fileName}, ${Math.ceil(f.size / 1024)}ك.ب)`).join('، ')}`,
    '',
    'قواعد القبول المطبقة على هذا البرنامج (مخصصة من الإدارة أو افتراضية):',
    JSON.stringify(programRules, null, 1),
    '',
    'نتائج الفحص الآلي بالقواعد:',
    ...rules.checklist.map((c) => `- [${c.status}] ${c.requirement}: ${c.detail}`),
    ...rules.findings.map((f) => `- ملاحظة (${f.severity}): ${f.title} — ${f.detail}`),
    '',
    ...ocrEvidence.length ? ['نتائج قراءة صور المستندات بالذكاء الاصطناعي (Vision):', ...ocrEvidence, ''] : [],
    'مقتطفات نصية من المستندات القابلة للقراءة:',
    ...files.filter((f) => f.textSnippet.length > 40).map((f) => `[${f.docType} — ${f.fileName}]: ${f.textSnippet.slice(0, 1200)}`),
    app.notes ? `\nملاحظات كتبها المتقدم: ${app.notes.slice(0, 500)}` : '',
  ].join('\n')

  let review: AdmissionAIReview
  try {
    const zai = await getZAI()
    const raw = await chatWithRetry(zai, [
      { role: 'assistant', content: 'أنت مساعد قبول أكاديمي خبير في ${ACAD} تقيّم ملفات المتقدمين وتُرجع JSON صالحاً فقط دون أي نص إضافي.'.replace('${ACAD}', 'الأكاديمية الأمريكية للاستشارات والتدريب') },
      {
        role: 'user',
        content: `قيّم طلب الالتحاق التالي بموضوعية كأنك مسؤول قبول محترف يعدّ مذكرة للإدارة قبل اجتماعها:

${evidence}

مهمتك:
1. طبّق قواعد قبول هذا البرنامج المذكورة أعلاه (المخصصة من الإدارة) حرفياً على المرفقات والبيانات المعلنة.
2. اقرأ نتائج قراءة صور المستندات (Vision) بعناية: إذا قرأ الذكاء صورة الشهادة ووجد درجة أقل من المطلوب فهذه حجة قوية.
3. افحص منطقية البيانات: العمر مقابل المؤهل، اتساق الأسماء بين ما هو معلن وما ظهر على المستندات، ووضوح المستندات.
4. إذا وُجدت قواعد مخصصة (customRules) فافحص الطلب ضدها وأدرج أي مخالفة في الملاحظات.
5. كن عادلاً: إذا كان الملف مكتملاً ومطابقاً للقواعد أوصِ بالاعتماد؛ إذا فيه نقص جوهري أو تناقض فاحذر الإدارة بوضوح.

أجب بصيغة JSON فقط:
{"verdict":"RECOMMEND_APPROVE|NEEDS_CLARIFICATION|RECOMMEND_REJECT|INSUFFICIENT_DATA","fitScore":<0-100>,"summaryForAdmin":"<ملخص 2-4 جمل للإدارة>","findings":[{"severity":"HIGH|MEDIUM|LOW","title":"<عنوان>","detail":"<تفصيل>"}],"strengths":["<نقطة قوة>"],"recommendedAction":"<توصية تنفيذية واحدة بالعربية>","requiredFromStudent":"<ما يُطلب من الطالب استكماله أو توضيحه إن وجد — أو سلسلة فارغة>"}`,
      },
    ])

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])

    const aiVerdict = (['RECOMMEND_APPROVE', 'NEEDS_CLARIFICATION', 'RECOMMEND_REJECT', 'INSUFFICIENT_DATA'].includes(parsed.verdict)
      ? parsed.verdict
      : 'NEEDS_CLARIFICATION') as Verdict

    // الجمع: الأسوأ بين حكم القواعد والحكم الذكي
    let finalVerdict: Verdict = aiVerdict
    if (rules.hardProblems > 0) finalVerdict = worseVerdict(finalVerdict, 'NEEDS_CLARIFICATION')
    if (app.files.length === 0) finalVerdict = 'INSUFFICIENT_DATA'

    const aiFindings: Finding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .slice(0, 8)
      .map((f: any) => ({
        severity: ['HIGH', 'MEDIUM', 'LOW'].includes(f?.severity) ? f.severity : 'MEDIUM',
        title: String(f?.title || 'ملاحظة').slice(0, 120),
        detail: String(f?.detail || '').slice(0, 500),
      }))

    review = {
      verdict: finalVerdict,
      fitScore: Math.max(0, Math.min(100, Math.round(Number(parsed.fitScore) || 0))),
      summaryForAdmin: String(parsed.summaryForAdmin || '').slice(0, 1200),
      checklist: rules.checklist,
      findings: [...rules.findings.map((f) => ({ ...f })), ...aiFindings].slice(0, 12),
      strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).slice(0, 5).map((s: any) => String(s).slice(0, 200)),
      recommendedAction: String(parsed.recommendedAction || '').slice(0, 500),
      engine: 'AI+RULES',
      analyzedAt: new Date().toISOString(),
    }
    // مطلوب من الطالب إن وجد
    const req = String(parsed.requiredFromStudent || '').trim()
    if (req && finalVerdict !== 'RECOMMEND_APPROVE') {
      review.findings.push({ severity: 'MEDIUM', title: 'مطلوب من الطالب', detail: req.slice(0, 500) })
    }
  } catch (e: any) {
    // احتياطي: تحليل قواعدي فقط إذا فشل النموذج
    const finalVerdict: Verdict =
      app.files.length === 0 ? 'INSUFFICIENT_DATA' : rules.hardProblems > 0 ? 'NEEDS_CLARIFICATION' : 'RECOMMEND_APPROVE'
    review = {
      verdict: finalVerdict,
      fitScore: Math.max(0, 100 - rules.hardProblems * 20 - rules.checklist.filter((c) => c.status === 'UNVERIFIED').length * 5),
      summaryForAdmin:
        `فحص آلي بالقواعد: ${rules.checklist.filter((c) => c.status === 'FOUND').length}/${rules.checklist.length} متطلباً مستوفى. ` +
        (rules.hardProblems > 0 ? `توجد ${rules.hardProblems} مشكلة جوهرية تحتاج مراجعة.` : 'لم تُرصد مشاكل جوهرية بالقواعد.') +
        ' (تعذر تحليل النموذج اللغوي — هذه نتيجة القواعد فقط)',
      checklist: rules.checklist,
      findings: rules.findings,
      strengths: [],
      recommendedAction: rules.hardProblems > 0 ? 'راجع الملاحظات الجوهرية قبل قرار الاعتماد' : 'الملف مستوفٍ للقواعد — قرار الاعتماد للإدارة',
      engine: 'RULES_ONLY',
      analyzedAt: new Date().toISOString(),
    }
    console.error('admission-ai LLM failed:', String(e?.message || e).slice(0, 150))
  }

  // حفظ في ملف الطلب ليقرأها أي مسؤول قبل الاعتماد
  await db.admissionApplication.update({
    where: { id: admissionId },
    data: {
      aiReview: JSON.stringify(review),
      aiVerdict: review.verdict,
      aiScore: review.fitScore,
      aiReviewedAt: new Date(),
    },
  })

  return { review, cached: false }
}

export { VERDICT_AR }
