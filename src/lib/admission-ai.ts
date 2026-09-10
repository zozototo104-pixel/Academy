import { db } from '@/lib/db'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { readDocumentImage, DOC_TYPE_AR, inferMimeFromFileName, isVisualFile, type ImageDocRead } from '@/lib/ocr'
import { extractDocumentText, type ExtractedDocumentText } from '@/lib/document-extract'
import { updateStudentAcademicMemory } from '@/lib/supervisor-ai'

// ===== قواعد القبول المخصصة لكل برنامج (تضبطها الإدارة من لوحة الإدارة) =====
export interface AdmissionRules {
  minEducation?: 'HIGH_SCHOOL' | 'BACHELOR' | 'MASTER' | 'NONE'
  requireMasterForDoctorate?: boolean
  allowExperienceEquivalency?: boolean
  minYearsExperience?: number
  requiredDocuments?: string[]
  minAge?: number
  customRules?: string
  displayNote?: string
  /** ملف أكاديمي مخصص للبرنامج محفوظ داخل نفس JSON لتجنب Migration إضافي. */
  academicProfile?: unknown
}

export const DEFAULT_REQUIRED_DOCS = ['DEGREE', 'ID', 'PHOTO', 'CV']

const EDU_RANK: Record<string, number> = { NONE: 0, OTHER: 0, HIGH_SCHOOL: 1, BACHELOR: 2, MASTER: 3, PHD: 4 }

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

// ===== خبير القبول الذكي: قراءة وفحص طلبات الالتحاق قبل قرار الإدارة =====
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

interface AdmissionFileEvidence {
  docType: string
  fileName: string
  mimeType: string
  size: number
  textSnippet: string
  textReader: ExtractedDocumentText['reader'] | 'IMAGE'
  textNote: string
  ocrRead?: ImageDocRead | null
}

interface RuleResult {
  checklist: ChecklistItem[]
  findings: Finding[]
  hardProblems: number
  unverifiableRequired: number
  docTextFound: boolean
  requiredFound: number
  requiredTotal: number
  deterministicScore: number
  verdict: Verdict
}

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_TEXT_EVIDENCE_FILES = 16
const MAX_VISION_FILES = 10

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
  PHD: 'الدكتوراه',
  OTHER: 'مؤهل آخر',
  NONE: 'غير محدد',
}

export const EDU_LABEL = EDUCATION_AR

const KEYWORDS = {
  highSchool: ['ثانويه', 'الثانويه', 'الشهاده الثانويه', 'high school', 'secondary school', 'secondary certificate'],
  bachelor: ['بكالوريوس', 'بكلوريوس', 'بكلاريوس', 'اجازه', 'ليسانس', 'bachelor', 'b.sc', 'bsc', 'b.a', 'ba degree'],
  master: ['ماجستير', 'master', 'm.sc', 'msc', 'm.a', 'mba', 'master degree'],
  phd: ['دكتوراه', 'دكتوراة', 'phd', 'doctorate'],
  degreeDoc: ['شهاده', 'شهادة', 'certificate', 'diploma', 'degree', 'graduation', 'awarded', 'granted', 'تشهد', 'منح', 'حصل على'],
  transcriptDoc: ['كشف علامات', 'كشف درجات', 'transcript', 'academic record', 'grade report', 'gpa', 'المعدل', 'الساعات المعتمده', 'الساعات المعتمدة', 'course title', 'semester'],
  idDoc: ['هويه', 'هوية', 'جواز', 'passport', 'national id', 'identity', 'id card', 'بطاقه', 'بطاقة'],
  cvDoc: ['سيره ذاتيه', 'سيرة ذاتية', 'cv', 'resume', 'curriculum vitae', 'خبره', 'خبرات', 'experience', 'skills', 'مهارات'],
  photoDoc: ['صوره شخصيه', 'صورة شخصية', 'personal photo', 'portrait', 'headshot', 'face', 'وجه', 'بورتريه'],
  logo: ['شعار', 'logo', 'seal only', 'ختم فقط', 'ايقونه', 'أيقونة', 'رمز'],
  platformUi: [
    'vercel', 'deployment', 'deployments', 'environment variables', 'nextauth', 'gemini_api_key', 'gemini_live_model',
    'production and preview', 'runtime logs', 'build logs', 'turbopack', 'academy-', '.vercel.app', 'vercel.com',
    'المشرف الذكي', 'تعذر بدء المحادثه الصوتيه', 'اعاده التحليل', 'درجة توافق الملف', 'درجه توافق الملف',
    'مقارنه الملف بمتطلبات البرنامج', 'توصيه خبير الذكاء الاصطناعي', 'اخفاء التفاصيل', 'مرفوع', 'whatsapp', 'واتساب',
  ],
  electronics: ['uni-t', 'ut33', 'hold', 'off 20m', 'cat ii', '600v', '300v', '10a', 'vΩma', 'vΩ', 'com ce', 'multimeter', 'ملتيميتر'],
}

function normalize(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasAny(haystack: string, list: string[]): boolean {
  const h = normalize(haystack)
  return list.some((kw) => h.includes(normalize(kw)))
}

function matchKeywords(haystack: string, list: string[]): string | null {
  const h = normalize(haystack)
  for (const kw of list) if (h.includes(normalize(kw))) return kw
  return null
}

type DetectedDocKind =
  | 'DEGREE_CERTIFICATE'
  | 'TRANSCRIPT'
  | 'ID'
  | 'CV'
  | 'PHOTO'
  | 'LOGO'
  | 'NON_ADMISSION'
  | 'OTHER_DOCUMENT'
  | 'UNVERIFIED'

const DETECTED_KIND_AR: Record<DetectedDocKind, string> = {
  DEGREE_CERTIFICATE: 'شهادة علمية',
  TRANSCRIPT: 'كشف درجات/علامات',
  ID: 'هوية أو جواز سفر',
  CV: 'سيرة ذاتية',
  PHOTO: 'صورة شخصية',
  LOGO: 'شعار/ختم فقط',
  NON_ADMISSION: 'مرفق غير تابع للقبول',
  OTHER_DOCUMENT: 'مستند آخر',
  UNVERIFIED: 'غير متحقق آلياً',
}

function isVisionUnavailable(f?: AdmissionFileEvidence | null): boolean {
  if (!f?.ocrRead) return false
  const raw = normalize([
    f.ocrRead.docTypeDetected,
    f.ocrRead.extractedText,
    f.ocrRead.qualityNote,
    f.ocrRead.matchNote,
  ].filter(Boolean).join(' '))
  return !f.ocrRead.readable && /لم تقرا الصوره اليا|لم يكتمل تحليله|خدمه قراءه الصور مشغوله|انتهت حصه قراءه الصور|تعذر تشغيل قارئ الصور|gemini vision|legacy vision|503|high demand/.test(raw)
}

function safeVisibleContent(f: AdmissionFileEvidence): string {
  if (isVisionUnavailable(f)) return ''
  return [
    f.textSnippet,
    f.ocrRead?.extractedText,
  ].filter(Boolean).join(' ')
}

function evidenceBlob(f: AdmissionFileEvidence): string {
  if (isVisionUnavailable(f)) return [f.fileName, f.mimeType].filter(Boolean).join(' ')
  return [
    f.fileName,
    f.mimeType,
    f.textSnippet,
    f.ocrRead?.docTypeDetected,
    f.ocrRead?.degreeMentioned,
    f.ocrRead?.nameOnDoc,
    f.ocrRead?.institution,
    f.ocrRead?.extractedText,
  ].filter(Boolean).join(' ')
}

function degreeFromEvidence(f?: AdmissionFileEvidence | null): keyof typeof EDU_RANK {
  if (!f || nonAdmissionAttachmentReason(f)) return 'NONE'
  const actual = detectAdmissionDocumentKind(f)
  if (!['DEGREE_CERTIFICATE', 'TRANSCRIPT'].includes(actual.kind)) return 'NONE'
  if (f.ocrRead?.degreeMentioned && f.ocrRead.degreeMentioned !== 'NONE') return f.ocrRead.degreeMentioned as keyof typeof EDU_RANK
  const blob = evidenceBlob(f)
  if (hasAny(blob, KEYWORDS.phd)) return 'PHD'
  if (hasAny(blob, KEYWORDS.master)) return 'MASTER'
  if (hasAny(blob, KEYWORDS.bachelor)) return 'BACHELOR'
  if (hasAny(blob, KEYWORDS.highSchool)) return 'HIGH_SCHOOL'
  return 'NONE'
}

function nonAdmissionAttachmentReason(f?: AdmissionFileEvidence | null): string | null {
  if (!f || isVisionUnavailable(f)) return null
  const visible = [
    safeVisibleContent(f),
    f.ocrRead?.docTypeDetected,
    f.ocrRead?.qualityNote,
    f.ocrRead?.matchNote,
  ].filter(Boolean).join(' ')
  const n = normalize(visible)

  if (hasAny(visible, KEYWORDS.platformUi) || /لقطه شاشه|لقطة شاشة|سكرين|screenshot|webpage|website|صفحه ويب|صفحة ويب|واجهه نظام|واجهة نظام|لوحه تحكم|لوحة تحكم|vercel|deployments|environment variables/.test(n)) {
    return 'المرفق عبارة عن لقطة شاشة من موقع/منصة/واجهة نظام، وليس شهادة أو هوية أو صورة شخصية أو سيرة ذاتية؛ لا يُحتسب ضمن مرفقات القبول.'
  }

  if (hasAny(visible, KEYWORDS.electronics)) {
    return 'المرفق يظهر جهازاً/أداة إلكترونية أو كتابة تقنية على جهاز، وليس صورة شخصية أو مستند قبول.'
  }

  if (/محادثه|محادثة|chat|رساله|رسالة|whatsapp|واتساب|browser|safari|chrome/.test(n)) {
    return 'المرفق يبدو لقطة محادثة أو متصفح، وليس مستند قبول رسمي.'
  }

  return null
}

function detectAdmissionDocumentKind(f: AdmissionFileEvidence): { kind: DetectedDocKind; reason: string } {
  if (isVisionUnavailable(f)) {
    return { kind: 'UNVERIFIED', reason: 'لم تكتمل قراءة الصورة آلياً الآن' }
  }

  const nonDoc = nonAdmissionAttachmentReason(f)
  if (nonDoc) return { kind: 'NON_ADMISSION', reason: nonDoc }

  const blob = evidenceBlob(f)
  const detected = [f.ocrRead?.docTypeDetected, f.ocrRead?.matchNote, f.ocrRead?.qualityNote].filter(Boolean).join(' ')
  const n = normalize(`${detected} ${blob}`)

  if (hasAny(blob, KEYWORDS.logo)) {
    return { kind: 'LOGO', reason: 'ظهر أنه شعار/ختم/رمز فقط وليس مستند قبول مكتمل' }
  }

  if (hasAny(detected, KEYWORDS.photoDoc) || (/صوره شخصيه|صورة شخصية|وجه|بورتريه|portrait|headshot|personal photo/.test(n) && !hasAny(blob, KEYWORDS.idDoc) && !hasAny(blob, KEYWORDS.degreeDoc))) {
    return { kind: 'PHOTO', reason: 'تم التعرف عليه كصورة شخصية/وجه' }
  }

  if (hasAny(blob, KEYWORDS.idDoc) || /national\s*id|passport|رقم جواز|رقم الهويه|رقم الهوية/.test(n)) {
    return { kind: 'ID', reason: 'يحتوي مؤشرات هوية أو جواز سفر' }
  }

  if (hasAny(blob, KEYWORDS.cvDoc) || /education|work experience|professional experience|الموارد البشريه|الخبرات العمليه|المؤهلات العلميه|المهارات|objective|profile/.test(n)) {
    return { kind: 'CV', reason: 'يحتوي مؤشرات سيرة ذاتية/خبرات/مهارات' }
  }

  if (hasAny(blob, KEYWORDS.transcriptDoc) || /gpa|grade|credit hours|course|marks|علامه|علامات|درجه|درجات|معدل|مساق|مواد دراسيه/.test(n)) {
    return { kind: 'TRANSCRIPT', reason: 'يحتوي مؤشرات كشف درجات/علامات أو سجل أكاديمي' }
  }

  if (hasAny(blob, KEYWORDS.degreeDoc) || hasAny(blob, KEYWORDS.highSchool) || hasAny(blob, KEYWORDS.bachelor) || hasAny(blob, KEYWORDS.master) || hasAny(blob, KEYWORDS.phd)) {
    return { kind: 'DEGREE_CERTIFICATE', reason: 'يحتوي مؤشرات شهادة علمية/مؤهل دراسي' }
  }

  if ((f.textSnippet || f.ocrRead?.extractedText || '').replace(/\s+/g, '').length >= 30 || f.ocrRead?.readable) {
    return { kind: 'OTHER_DOCUMENT', reason: 'تمت قراءته لكنه لا يطابق الأنواع المطلوبة بوضوح' }
  }

  return { kind: 'UNVERIFIED', reason: 'لم يظهر دليل كافٍ لتحديد نوع المستند' }
}

function kindSatisfiesRequirement(expectedType: string, kind: DetectedDocKind): boolean {
  if (expectedType === 'DEGREE') return kind === 'DEGREE_CERTIFICATE' || kind === 'TRANSCRIPT'
  if (expectedType === 'ID') return kind === 'ID'
  if (expectedType === 'CV') return kind === 'CV'
  if (expectedType === 'PHOTO') return kind === 'PHOTO'
  return kind === 'OTHER_DOCUMENT'
}

function isImageFile(f: AdmissionFileEvidence): boolean {
  return f.mimeType.startsWith('image/')
}

function expectedDocMatches(expectedType: string, f: AdmissionFileEvidence): { ok: boolean; problem: boolean; reason: string } {
  if (isVisionUnavailable(f)) {
    return {
      ok: false,
      problem: false,
      reason: 'وصل المرفق، لكن قارئ الصور لم يكمل التحليل بسبب انشغال الخدمة أو تعذر مؤقت؛ لا يُحتسب كمطابق قبل إعادة التحليل أو المراجعة اليدوية.',
    }
  }

  const actual = detectAdmissionDocumentKind(f)
  if (actual.kind === 'NON_ADMISSION' || actual.kind === 'LOGO') {
    return { ok: false, problem: true, reason: actual.reason }
  }

  if (actual.kind === 'UNVERIFIED') {
    return { ok: false, problem: false, reason: actual.reason }
  }

  if (expectedType === 'PHOTO') {
    if (!isImageFile(f)) return { ok: false, problem: true, reason: 'الصورة الشخصية يجب أن تكون ملف صورة واضحاً' }
    if (actual.kind === 'PHOTO') return { ok: true, problem: false, reason: `النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
    return { ok: false, problem: true, reason: `المطلوب صورة شخصية، لكن النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
  }

  if (expectedType === 'DEGREE') {
    if (actual.kind === 'DEGREE_CERTIFICATE' || actual.kind === 'TRANSCRIPT') {
      const degree = degreeFromEvidence(f)
      return {
        ok: true,
        problem: false,
        reason: degree !== 'NONE'
          ? `النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — يظهر مؤهل: ${EDUCATION_AR[degree] || degree}`
          : `النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}`,
      }
    }
    return { ok: false, problem: true, reason: `المطلوب شهادة/كشف درجات، لكن النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
  }

  if (expectedType === 'ID') {
    if (actual.kind === 'ID') return { ok: true, problem: false, reason: `النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
    return { ok: false, problem: true, reason: `المطلوب هوية/جواز، لكن النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
  }

  if (expectedType === 'CV') {
    if (actual.kind === 'CV') return { ok: true, problem: false, reason: `النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
    return { ok: false, problem: true, reason: `المطلوب سيرة ذاتية، لكن النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]} — ${actual.reason}` }
  }

  const readable = f.textSnippet.length >= 30 || !!f.ocrRead?.readable
  return { ok: readable, problem: false, reason: readable ? 'مرفق قابل للقراءة' : 'غير قابل للتحقق آلياً' }
}

function fileDetail(f: AdmissionFileEvidence, extra?: string): string {
  const actual = detectAdmissionDocumentKind(f)
  const actualLabel = ` — النوع الحقيقي المكتشف: ${DETECTED_KIND_AR[actual.kind]}`
  const base = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب)${actualLabel}`
  const visibleText = safeVisibleContent(f).replace(/\s+/g, ' ').trim().slice(0, 220)
  const read = isVisionUnavailable(f)
    ? ` — لم تكتمل قراءة الصورة آلياً الآن — ${f.ocrRead?.qualityNote || f.textNote || 'أعد التحليل لاحقاً أو راجعها يدوياً'}`
    : f.textSnippet.length >= 30
      ? ` — تمت قراءة المحتوى آلياً (${f.textReader})${visibleText ? ` — محتوى ظاهر: ${visibleText}` : ''}`
      : f.ocrRead
        ? ` — نتيجة الرؤية: ${f.ocrRead.docTypeDetected || 'غير محدد'}${visibleText ? ` — محتوى/وصف ظاهر: ${visibleText}` : ''}${f.ocrRead.qualityNote ? ` — ${f.ocrRead.qualityNote}` : ''}`
        : ` — ${f.textNote || 'غير قابل للقراءة الآلية'}`
  return `${base}${read}${extra ? ` — ${extra}` : ''}`
}

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

function computeRuleScore(args: {
  checklist: ChecklistItem[]
  findings: Finding[]
  hardProblems: number
  unverifiableRequired: number
  requiredFound: number
  requiredTotal: number
  fileCount: number
  docTextFound: boolean
}): { score: number; verdict: Verdict } {
  if (args.fileCount === 0) return { score: 0, verdict: 'INSUFFICIENT_DATA' }

  const missing = args.checklist.filter((c) => c.status === 'MISSING').length
  const problem = args.checklist.filter((c) => c.status === 'PROBLEM').length
  const unverified = args.checklist.filter((c) => c.status === 'UNVERIFIED').length
  const high = args.findings.filter((f) => f.severity === 'HIGH').length
  const medium = args.findings.filter((f) => f.severity === 'MEDIUM').length

  let score = Math.round((args.requiredFound / Math.max(1, args.requiredTotal)) * 100)
  score -= missing * 18 + problem * 20 + unverified * 9 + high * 12 + medium * 4 + args.hardProblems * 4

  if (!args.docTextFound) score = Math.min(score, 20)
  if (args.requiredFound === 0) score = Math.min(score, 10)
  if (problem > 0) score = Math.min(score, 45)
  if (missing > 0) score = Math.min(score, 55)
  if (args.unverifiableRequired >= 2) score = Math.min(score, 58)
  if (args.hardProblems >= 3) score = Math.min(score, 30)
  if (args.requiredFound === args.requiredTotal && args.hardProblems === 0 && problem === 0 && missing === 0 && unverified === 0) score = Math.max(score, 82)

  score = Math.max(0, Math.min(100, Math.round(score)))

  let verdict: Verdict
  if (score >= 78 && args.hardProblems === 0 && missing === 0 && problem === 0 && args.unverifiableRequired === 0) verdict = 'RECOMMEND_APPROVE'
  else if (score < 25 || problem >= 2 || args.hardProblems >= 3) verdict = 'RECOMMEND_REJECT'
  else verdict = 'NEEDS_CLARIFICATION'

  return { score, verdict }
}

function runRules(app: {
  fullName: string
  education: string
  program: string
  programCategory: string
  nationalId?: string | null
  birthDate?: Date | null
  country?: string | null
  rules: AdmissionRules
  files: AdmissionFileEvidence[]
}): RuleResult {
  const rules = app.rules
  const checklist: ChecklistItem[] = []
  const findings: Finding[] = []
  let hardProblems = 0
  let unverifiableRequired = 0
  let docTextFound = false
  let requiredFound = 0

  const reqDocs = rules.requiredDocuments || DEFAULT_REQUIRED_DOCS

  for (const type of reqDocs) {
    const label = DOC_TYPE_AR[type] || type
    const declaredCandidates = app.files.filter((f) => f.docType === type)
    const autoDetectedCandidates = app.files.filter((f) => {
      if (f.docType === type) return false
      const actual = detectAdmissionDocumentKind(f)
      return kindSatisfiesRequirement(type, actual.kind)
    })
    const candidates = [...declaredCandidates, ...autoDetectedCandidates]
    if (candidates.length === 0) {
      checklist.push({ requirement: label, status: 'MISSING', detail: 'لم يُرفع أو يُكتشف هذا المستند آلياً ضمن المرفقات (مطلوب وفق قواعد قبول البرنامج)' })
      hardProblems++
      continue
    }

    const evaluated = candidates.map((f) => ({ f, match: expectedDocMatches(type, f) }))
    const good = evaluated.find((x) => x.match.ok)
    const bad = evaluated.find((x) => x.match.problem)

    if (good) {
      requiredFound++
      if (type !== 'PHOTO') docTextFound = true
      const placementNote = good.f.docType === type ? '' : `تم اكتشافه آلياً رغم أنه مرفوع تحت خانة «${DOC_TYPE_AR[good.f.docType] || good.f.docType}»`
      checklist.push({ requirement: label, status: 'FOUND', detail: fileDetail(good.f, [good.match.reason, placementNote].filter(Boolean).join(' — ')) })
    } else if (bad) {
      checklist.push({ requirement: label, status: 'PROBLEM', detail: fileDetail(bad.f, bad.match.reason) })
      findings.push({ severity: 'HIGH', title: `المرفق لا يطابق: ${label}`, detail: bad.match.reason })
      hardProblems++
    } else {
      const f = candidates[0]
      checklist.push({ requirement: label, status: 'UNVERIFIED', detail: fileDetail(f, evaluated[0]?.match.reason || 'غير قابل للتحقق الآلي') })
      unverifiableRequired++
    }
  }

  const degreeFiles = app.files.filter((f) => f.docType === 'DEGREE' || kindSatisfiesRequirement('DEGREE', detectAdmissionDocumentKind(f).kind))
  const bestDegree = degreeFiles
    .map((f) => ({ f, degree: degreeFromEvidence(f) }))
    .sort((a, b) => (EDU_RANK[b.degree] || 0) - (EDU_RANK[a.degree] || 0))[0]

  const cat = app.programCategory
  const eduRank = EDU_RANK[app.education] ?? 0
  const minRank = EDU_RANK[rules.minEducation || 'HIGH_SCHOOL'] ?? 1
  const minLabel = EDUCATION_AR[rules.minEducation || 'HIGH_SCHOOL'] || rules.minEducation || 'الثانوية'
  const detectedRank = EDU_RANK[bestDegree?.degree || 'NONE'] || 0

  if (cat === 'DOCTORATE' && rules.requireMasterForDoctorate) {
    const declaredMaster = app.education === 'MASTER' || app.education === 'PHD'
    const detectedMaster = detectedRank >= EDU_RANK.MASTER

    checklist.push({
      requirement: 'المؤهل المطلوب للدكتوراة: ماجستير مهني أو أكاديمي' + (rules.allowExperienceEquivalency ? ' (أو معادلة خبرات موثقة)' : ''),
      status: declaredMaster ? 'FOUND' : app.education === 'BACHELOR' && rules.allowExperienceEquivalency ? 'UNVERIFIED' : 'PROBLEM',
      detail: declaredMaster
        ? 'الطالب أعلن حيازة ماجستير/دراسات عليا'
        : app.education === 'BACHELOR' && rules.allowExperienceEquivalency
          ? `أعلن بكالوريوس فقط — يمكن النظر بمعادلة خبرات إذا ثبتت خبرة لا تقل عن ${rules.minYearsExperience || 8} سنوات`
          : `أعلن: ${EDUCATION_AR[app.education] || app.education} — أقل من المطلوب للدكتوراة`,
    })

    if (bestDegree) {
      checklist.push({
        requirement: 'التحقق من شهادة الدراسات العليا',
        status: detectedMaster ? 'FOUND' : bestDegree.degree === 'BACHELOR' ? 'PROBLEM' : 'UNVERIFIED',
        detail: detectedMaster
          ? `المرفق يثبت درجة ${EDUCATION_AR[bestDegree.degree] || bestDegree.degree}`
          : bestDegree.degree === 'BACHELOR'
            ? 'المرفق المقروء يثبت بكالوريوس فقط ولا يثبت ماجستير'
            : 'لم يظهر في مرفق الشهادة دليل واضح على وجود ماجستير',
      })
      if (!detectedMaster && bestDegree.degree === 'BACHELOR' && !rules.allowExperienceEquivalency) hardProblems++
      if (!detectedMaster && declaredMaster) unverifiableRequired++
    } else {
      checklist.push({ requirement: 'التحقق من شهادة الدراسات العليا', status: 'MISSING', detail: 'لم يُرفع مستند شهادة قابل للفحص' })
      hardProblems++
    }
  } else {
    const declaredOK = eduRank >= minRank
    checklist.push({
      requirement: `المؤهل المطلوب: ${minLabel} على الأقل`,
      status: declaredOK ? 'FOUND' : 'PROBLEM',
      detail: declaredOK ? `أعلن: ${EDUCATION_AR[app.education] || app.education}` : `أعلن: ${EDUCATION_AR[app.education] || app.education} — الحد الأدنى وفق قواعد البرنامج هو ${minLabel}`,
    })
    if (!declaredOK) hardProblems++

    if (bestDegree) {
      const matches = detectedRank >= minRank
      checklist.push({
        requirement: 'التحقق من نص/صورة الشهادة',
        status: detectedRank > 0 ? (matches ? 'FOUND' : 'PROBLEM') : 'UNVERIFIED',
        detail: detectedRank > 0
          ? matches
            ? `قرأ النظام من المرفق درجة ${EDUCATION_AR[bestDegree.degree] || bestDegree.degree} وهي مستوفية للحد الأدنى`
            : `قرأ النظام من المرفق درجة ${EDUCATION_AR[bestDegree.degree] || bestDegree.degree} وهي أقل من الحد الأدنى (${minLabel})`
          : 'لم يظهر في مرفق الشهادة دليل نصي واضح على المؤهل المطلوب',
      })
      if (detectedRank > 0 && !matches) hardProblems++
      if (detectedRank === 0) unverifiableRequired++
    }
  }

  const minAge = rules.minAge || 16
  if (app.birthDate) {
    const age = (Date.now() - new Date(app.birthDate).getTime()) / (365.25 * 24 * 3600 * 1000)
    const ageR = Math.floor(age)
    if (ageR < minAge) {
      findings.push({ severity: 'HIGH', title: 'العمر أقل من الحد الأدنى وفق قواعد البرنامج', detail: `العمر ${ageR} سنة والحد الأدنى المحدد ${minAge} سنة` })
      hardProblems++
    } else if (app.education === 'MASTER' && ageR < 22) {
      findings.push({ severity: 'HIGH', title: 'تناقض العمر مع المؤهل', detail: `العمر ${ageR} سنة مع إعلان ماجستير — غير منطقي زمنياً` })
      hardProblems++
    } else if (app.education === 'BACHELOR' && ageR < 18) {
      findings.push({ severity: 'HIGH', title: 'تناقض العمر مع المؤهل', detail: `العمر ${ageR} سنة مع إعلان بكالوريوس — غير منطقي زمنياً` })
      hardProblems++
    }
  }

  const ocrName = app.files.find((f) => f.ocrRead?.readable && f.ocrRead.nameOnDoc)?.ocrRead?.nameOnDoc
  if (ocrName && app.fullName) {
    const script = (s: string) => /[\u0600-\u06ff]/.test(s) ? 'ar' : /[a-z]/i.test(s) ? 'en' : 'other'
    if (script(app.fullName) === script(ocrName)) {
      const normWords = (s: string) => normalize(s).split(' ').filter((w) => w.length > 1)
      const a = normWords(app.fullName)
      const b = normalize(ocrName)
      const shared = a.filter((w) => b.includes(w)).length
      if (a.length && shared < Math.ceil(a.length / 2)) {
        findings.push({ severity: 'MEDIUM', title: 'اختلاف الاسم مع المستند', detail: `الاسم المعلن «${app.fullName}» يختلف عن الاسم المقروء «${ocrName}» — يرجى التحقق` })
      }
    }
  }

  if (!app.nationalId?.trim()) {
    findings.push({ severity: 'MEDIUM', title: 'رقم الهوية/الجواز غير مذكور', detail: 'حقل الهوية فارغ رغم كونه إلزامياً' })
  }

  if (rules.customRules?.trim()) {
    checklist.push({ requirement: 'قواعد البرنامج المخصصة', status: 'UNVERIFIED', detail: `توجد قواعد مخصصة يجب مراجعتها مع الأدلة: ${rules.customRules.slice(0, 300)}` })
  }

  if (app.files.some((f) => hasAny(evidenceBlob(f), KEYWORDS.logo))) {
    findings.push({ severity: 'HIGH', title: 'مرفقات غير وثائقية', detail: 'رُصدت صور شعارات/رموز أو مرفقات لا تثبت المتطلبات؛ لا يجوز احتسابها كشهادة أو هوية أو سيرة ذاتية.' })
    hardProblems++
  }

  const scoreResult = computeRuleScore({
    checklist,
    findings,
    hardProblems,
    unverifiableRequired,
    requiredFound,
    requiredTotal: reqDocs.length,
    fileCount: app.files.length,
    docTextFound,
  })

  return {
    checklist,
    findings,
    hardProblems,
    unverifiableRequired,
    docTextFound,
    requiredFound,
    requiredTotal: reqDocs.length,
    deterministicScore: scoreResult.score,
    verdict: scoreResult.verdict,
  }
}

async function buildFileEvidence(files: { docType: string; fileName: string; mimeType: string; size: number; data: string | null }[]): Promise<AdmissionFileEvidence[]> {
  const out: AdmissionFileEvidence[] = []
  let textReads = 0
  let visionReads = 0

  for (const f of files) {
    let textSnippet = ''
    let textReader: AdmissionFileEvidence['textReader'] = 'EMPTY'
    let textNote = 'لم تتم قراءة الملف'
    let ocrRead: ImageDocRead | null = null

    if (f.data) {
      const buf = Buffer.from(f.data, 'base64')
      const effectiveMime = inferMimeFromFileName(f.fileName, f.mimeType || 'application/octet-stream')
      if (isVisualFile(effectiveMime, f.fileName) && effectiveMime.startsWith('image/') && visionReads < MAX_VISION_FILES) {
        visionReads++
        ocrRead = await readDocumentImage(buf, effectiveMime, f.docType, DOC_TYPE_AR[f.docType] || f.docType, f.fileName)
        textSnippet = ocrRead?.extractedText || ''
        textReader = 'IMAGE'
        textNote = ocrRead
          ? (ocrRead.readable ? 'تمت قراءة الصورة بالرؤية الذكية' : `تم فحص الصورة بالرؤية الذكية لكنها لا تثبت المطلوب: ${ocrRead.docTypeDetected || ocrRead.qualityNote}`)
          : 'تعذر فحص الصورة بالرؤية الذكية'
      } else if (textReads < MAX_TEXT_EVIDENCE_FILES) {
        textReads++
        const extracted = await extractDocumentText(buf, effectiveMime, f.fileName, 12000)
        textSnippet = extracted.text
        textReader = extracted.reader
        textNote = extracted.note

        // إذا كان PDF غير نصي أو تعذر استخراج نصه، نمرره إلى Gemini Vision/Document Understanding
        // حتى يصف ما بداخله ولا يبقى التقرير يقول فقط "تعذر القراءة".
        const isPdf = effectiveMime.includes('pdf') || /\.pdf$/i.test(f.fileName)
        if (!extracted.readable && isPdf && visionReads < MAX_VISION_FILES) {
          visionReads++
          ocrRead = await readDocumentImage(buf, effectiveMime || 'application/pdf', f.docType, DOC_TYPE_AR[f.docType] || f.docType, f.fileName)
          if (ocrRead?.extractedText) {
            textSnippet = ocrRead.extractedText
            textReader = 'IMAGE'
            textNote = ocrRead.readable ? 'تمت قراءة PDF بالرؤية الذكية' : `تم فحص PDF بالرؤية الذكية: ${ocrRead.docTypeDetected || ocrRead.qualityNote}`
          }
        }
      }
    }

    out.push({
      docType: f.docType,
      fileName: f.fileName,
      mimeType: inferMimeFromFileName(f.fileName, f.mimeType || 'application/octet-stream'),
      size: f.size,
      textSnippet,
      textReader,
      textNote,
      ocrRead,
    })
  }
  return out
}

function summarizeEvidence(files: AdmissionFileEvidence[]): string {
  return files.map((f, i) => {
    const label = DOC_TYPE_AR[f.docType] || f.docType
    const actual = detectAdmissionDocumentKind(f)
    const match = expectedDocMatches(f.docType, f)
    const text = safeVisibleContent(f).replace(/\s+/g, ' ').slice(0, 1000)
    const note = isVisionUnavailable(f)
      ? (f.ocrRead?.qualityNote || 'لم تكتمل قراءة الصورة آلياً الآن')
      : f.textNote
    return `ملف ${i + 1}: التصنيف المختار عند الرفع=${label}; النوع الحقيقي المكتشف=${DETECTED_KIND_AR[actual.kind]}; الاسم=${f.fileName}; النوع=${f.mimeType}; الحجم=${Math.ceil(f.size / 1024)}ك.ب; القارئ=${f.textReader}; نتيجة المطابقة=${match.ok ? 'مطابق' : match.problem ? 'مشكلة' : 'غير متحقق'}; السبب=${match.reason}; ملاحظة القراءة=${note}; مقتطف=${text || '-'}`
  }).join('\n')
}

function buildRuleSummary(rules: RuleResult): string {
  return [
    `نسبة التغطية القواعدية الصارمة: ${rules.deterministicScore}%`,
    `المتطلبات المطلوبة: ${rules.requiredTotal} — المستوفى فعلياً: ${rules.requiredFound}`,
    `مشاكل جوهرية: ${rules.hardProblems} — مستندات غير قابلة للتحقق: ${rules.unverifiableRequired}`,
    `يوجد دليل نصي/مرئي موثق غير الصورة الشخصية: ${rules.docTextFound ? 'نعم' : 'لا'}`,
  ].join('\n')
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

  if (!opts?.force && app.aiReview && app.aiReviewedAt && Date.now() - new Date(app.aiReviewedAt).getTime() < CACHE_TTL_MS) {
    try {
      return { review: JSON.parse(app.aiReview) as AdmissionAIReview, cached: true }
    } catch {}
  }

  const programRules = resolveRules(app.programRef?.category || 'DIPLOMA', app.programRef?.admissionRules)
  const files = await buildFileEvidence(app.files)
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

  const cat = app.programRef?.category || 'DIPLOMA'
  const level = CATEGORY_AR[cat] || cat
  const evidence = [
    `اسم المتقدم: ${app.fullName}`,
    `البرنامج المتقدم له: ${app.program} (${level})`,
    `المؤهل المعلن: ${EDUCATION_AR[app.education] || app.education}`,
    `الدولة: ${app.country || '-'} — الهوية: ${app.nationalId || 'غير مذكورة'}`,
    app.birthDate ? `تاريخ الميلاد: ${new Date(app.birthDate).toLocaleDateString('ar-EG')} (العمر ${Math.floor((Date.now() - new Date(app.birthDate).getTime()) / (365.25 * 24 * 3600 * 1000))} سنة)` : 'تاريخ الميلاد: غير مذكور',
    '',
    'قواعد القبول المطبقة:',
    JSON.stringify(programRules, null, 1),
    '',
    'ملخص القواعد الصارمة:',
    buildRuleSummary(rules),
    '',
    'نتائج checklist القواعدية:',
    ...rules.checklist.map((c) => `- [${c.status}] ${c.requirement}: ${c.detail}`),
    ...rules.findings.map((f) => `- ملاحظة (${f.severity}): ${f.title} — ${f.detail}`),
    '',
    'قراءة كل المرفقات:',
    summarizeEvidence(files),
    app.notes ? `\nملاحظات كتبها المتقدم: ${app.notes.slice(0, 500)}` : '',
  ].join('\n')

  let review: AdmissionAIReview
  try {
    const zai = await getZAI()
    const raw = await chatWithRetry(zai, [
      { role: 'assistant', content: 'أنت خبير قبول أكاديمي صارم، لا ترفع النسبة إلا إذا كانت الأدلة المقروءة تثبت المتطلبات فعلاً. أرجع JSON صالحاً فقط.' },
      {
        role: 'user',
        content: `حلل طلب الالتحاق التالي. اعتمد على الأدلة المقروءة فقط، ولا تعتبر اسم الملف وحده دليلاً. إذا كانت المرفقات شعارات أو صوراً غير وثائقية أو غير قابلة للقراءة فالنسبة يجب أن تكون منخفضة جداً ولا تتجاوز 20%.

${evidence}

قواعد حاسمة:
- RECOMMEND_APPROVE فقط إذا كل المستندات المطلوبة مقروءة ومطابقة، والمؤهل مستوفى.
- إذا مرفق مصنف شهادة وهو شعار/صورة/هوية أو لا يحتوي مؤهلاً واضحاً، اعتبره مشكلة جوهرية.
- إذا مرفق مصنف هوية/جواز ولا يظهر هوية أو جواز، اعتبره مشكلة.
- إذا الصورة الشخصية ليست صورة وجه/بورتريه واضحة، اعتبرها مشكلة.
- لا تعط fitScore أعلى من نسبة التغطية القواعدية الصارمة المذكورة أعلاه إلا إذا كانت الأدلة تثبت ذلك بوضوح.

أجب بصيغة JSON فقط:
{"verdict":"RECOMMEND_APPROVE|NEEDS_CLARIFICATION|RECOMMEND_REJECT|INSUFFICIENT_DATA","fitScore":<0-100>,"summaryForAdmin":"<ملخص 2-4 جمل للإدارة>","findings":[{"severity":"HIGH|MEDIUM|LOW","title":"<عنوان>","detail":"<تفصيل>"}],"strengths":["<نقطة قوة حقيقية مثبتة فقط>"],"recommendedAction":"<توصية تنفيذية واحدة بالعربية>","requiredFromStudent":"<ما يُطلب من الطالب استكماله أو توضيحه إن وجد — أو سلسلة فارغة>"}`,
      },
    ])

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])

    const aiVerdict = (['RECOMMEND_APPROVE', 'NEEDS_CLARIFICATION', 'RECOMMEND_REJECT', 'INSUFFICIENT_DATA'].includes(parsed.verdict)
      ? parsed.verdict
      : 'NEEDS_CLARIFICATION') as Verdict
    const aiScore = Math.max(0, Math.min(100, Math.round(Number(parsed.fitScore) || 0)))

    const finalScore = Math.min(rules.deterministicScore, Number.isFinite(aiScore) ? aiScore : rules.deterministicScore)
    let finalVerdict: Verdict = worseVerdict(rules.verdict, aiVerdict)
    if (finalScore < 25) finalVerdict = app.files.length === 0 ? 'INSUFFICIENT_DATA' : 'RECOMMEND_REJECT'
    if (rules.hardProblems > 0 && finalVerdict === 'RECOMMEND_APPROVE') finalVerdict = 'NEEDS_CLARIFICATION'

    const aiFindings: Finding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .slice(0, 8)
      .map((f: any) => ({
        severity: ['HIGH', 'MEDIUM', 'LOW'].includes(f?.severity) ? f.severity : 'MEDIUM',
        title: String(f?.title || 'ملاحظة').slice(0, 120),
        detail: String(f?.detail || '').slice(0, 600),
      }))

    review = {
      verdict: finalVerdict,
      fitScore: finalScore,
      summaryForAdmin: String(parsed.summaryForAdmin || '').slice(0, 1200) || `فحص قواعدي صارم: التغطية ${rules.deterministicScore}%.`,
      checklist: rules.checklist,
      findings: [...rules.findings, ...aiFindings].slice(0, 14),
      strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).slice(0, 5).map((s: any) => String(s).slice(0, 220)),
      recommendedAction: String(parsed.recommendedAction || '').slice(0, 600) || (finalVerdict === 'RECOMMEND_APPROVE' ? 'يمكن للإدارة اعتماد الطلب بعد مراجعة بشرية نهائية' : 'اطلب من الطالب رفع مستندات صحيحة ومقروءة ثم أعد التحليل'),
      engine: 'AI+RULES',
      analyzedAt: new Date().toISOString(),
    }

    const req = String(parsed.requiredFromStudent || '').trim()
    if (req && finalVerdict !== 'RECOMMEND_APPROVE') {
      review.findings.push({ severity: 'MEDIUM', title: 'مطلوب من الطالب', detail: req.slice(0, 600) })
    }
  } catch (e: any) {
    review = {
      verdict: rules.verdict,
      fitScore: rules.deterministicScore,
      summaryForAdmin:
        `فحص آلي صارم بالقواعد: ${rules.requiredFound}/${rules.requiredTotal} متطلباً مستوفى. ` +
        (rules.hardProblems > 0 ? `توجد ${rules.hardProblems} مشكلة جوهرية.` : 'لم تُرصد مشاكل جوهرية بالقواعد.') +
        (rules.unverifiableRequired > 0 ? ` يوجد ${rules.unverifiableRequired} مرفق مطلوب غير قابل للتحقق.` : '') +
        ' (تعذر تحليل النموذج اللغوي — هذه نتيجة القواعد والقراءة الآلية فقط)',
      checklist: rules.checklist,
      findings: rules.findings,
      strengths: rules.requiredFound > 0 ? ['توجد بعض المرفقات المطابقة والمقروءة'] : [],
      recommendedAction: rules.verdict === 'RECOMMEND_APPROVE' ? 'الملف مستوفٍ للقواعد — قرار الاعتماد للإدارة' : 'لا تعتمد الطلب قبل رفع مرفقات صحيحة ومقروءة وإعادة التحليل',
      engine: 'RULES_ONLY',
      analyzedAt: new Date().toISOString(),
    }
    console.error('admission-ai LLM failed:', String(e?.message || e).slice(0, 180))
  }

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
