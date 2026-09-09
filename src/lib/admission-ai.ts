import { db } from '@/lib/db'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { readDocumentImage, DOC_TYPE_AR, type ImageDocRead } from '@/lib/ocr'
import { extractDocumentText, type ExtractedDocumentText } from '@/lib/document-extract'

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
  degreeDoc: ['شهاده', 'كشف علامات', 'كشف درجات', 'transcript', 'certificate', 'diploma', 'degree', 'graduation'],
  idDoc: ['هويه', 'هوية', 'جواز', 'passport', 'national id', 'identity', 'id card', 'بطاقه', 'بطاقة'],
  cvDoc: ['سيره ذاتيه', 'سيرة ذاتية', 'cv', 'resume', 'curriculum vitae', 'خبره', 'خبرات', 'experience', 'skills', 'مهارات'],
  photoDoc: ['صوره شخصيه', 'صورة شخصية', 'personal photo', 'portrait', 'headshot', 'face'],
  logo: ['شعار', 'logo', 'seal only', 'ختم فقط', 'ايقونه', 'أيقونة', 'رمز'],
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

function evidenceBlob(f: AdmissionFileEvidence): string {
  return [
    f.fileName,
    f.mimeType,
    f.textSnippet,
    f.textNote,
    f.ocrRead?.docTypeDetected,
    f.ocrRead?.degreeMentioned,
    f.ocrRead?.nameOnDoc,
    f.ocrRead?.institution,
    f.ocrRead?.extractedText,
    f.ocrRead?.qualityNote,
    f.ocrRead?.matchNote,
  ].filter(Boolean).join(' ')
}

function degreeFromEvidence(f?: AdmissionFileEvidence | null): keyof typeof EDU_RANK {
  if (!f) return 'NONE'
  if (f.ocrRead?.degreeMentioned && f.ocrRead.degreeMentioned !== 'NONE') return f.ocrRead.degreeMentioned as keyof typeof EDU_RANK
  const blob = evidenceBlob(f)
  if (hasAny(blob, KEYWORDS.phd)) return 'PHD'
  if (hasAny(blob, KEYWORDS.master)) return 'MASTER'
  if (hasAny(blob, KEYWORDS.bachelor)) return 'BACHELOR'
  if (hasAny(blob, KEYWORDS.highSchool)) return 'HIGH_SCHOOL'
  return 'NONE'
}

function isImageFile(f: AdmissionFileEvidence): boolean {
  return f.mimeType.startsWith('image/')
}

function expectedDocMatches(expectedType: string, f: AdmissionFileEvidence): { ok: boolean; problem: boolean; reason: string } {
  const blob = evidenceBlob(f)
  const detected = normalize(f.ocrRead?.docTypeDetected || '')
  const isLogo = hasAny(blob, KEYWORDS.logo)

  if (isLogo) {
    return { ok: false, problem: true, reason: 'المرفق يبدو شعاراً/ختمًا/صورة غير وثائقية، ولا يثبت المتطلب المطلوب' }
  }

  if (expectedType === 'PHOTO') {
    if (!isImageFile(f)) return { ok: false, problem: true, reason: 'الصورة الشخصية يجب أن تكون ملف صورة واضحاً' }
    if (hasAny(blob, KEYWORDS.photoDoc) && !hasAny(blob, KEYWORDS.idDoc) && !hasAny(blob, KEYWORDS.degreeDoc)) {
      return { ok: true, problem: false, reason: 'تظهر كصورة شخصية/وجه واضح' }
    }
    if (f.ocrRead && f.ocrRead.readable && detected && !hasAny(detected, KEYWORDS.photoDoc)) {
      return { ok: false, problem: true, reason: `المرفق مصنف صورة شخصية لكن الذكاء رآه: ${f.ocrRead.docTypeDetected || 'نوع آخر'}` }
    }
    return { ok: false, problem: false, reason: 'لم يتم التأكد آلياً أنها صورة شخصية واضحة' }
  }

  if (expectedType === 'DEGREE') {
    const degree = degreeFromEvidence(f)
    if (degree !== 'NONE' || hasAny(blob, KEYWORDS.degreeDoc)) {
      return { ok: true, problem: false, reason: degree !== 'NONE' ? `يظهر مؤهل: ${EDUCATION_AR[degree] || degree}` : 'يظهر أنه مستند شهادة/كشف درجات' }
    }
    if (hasAny(blob, KEYWORDS.idDoc) || hasAny(blob, KEYWORDS.cvDoc) || hasAny(blob, KEYWORDS.photoDoc)) {
      return { ok: false, problem: true, reason: 'المرفق المصنف شهادة يبدو أنه هوية/سيرة/صورة وليس شهادة أو كشف علامات' }
    }
    return { ok: false, problem: false, reason: 'لم يظهر نص أو دليل كافٍ على أنه شهادة أو كشف علامات' }
  }

  if (expectedType === 'ID') {
    if (hasAny(blob, KEYWORDS.idDoc)) return { ok: true, problem: false, reason: 'يظهر أنه هوية أو جواز سفر' }
    if (hasAny(blob, KEYWORDS.degreeDoc) || hasAny(blob, KEYWORDS.cvDoc) || hasAny(blob, KEYWORDS.photoDoc)) {
      return { ok: false, problem: true, reason: 'المرفق المصنف هوية/جواز يبدو أنه مستند آخر' }
    }
    return { ok: false, problem: false, reason: 'لم يظهر دليل كافٍ على أنه هوية أو جواز' }
  }

  if (expectedType === 'CV') {
    if (hasAny(blob, KEYWORDS.cvDoc)) return { ok: true, problem: false, reason: 'يحتوي مؤشرات سيرة ذاتية/خبرات/مهارات' }
    if (hasAny(blob, KEYWORDS.degreeDoc) || hasAny(blob, KEYWORDS.idDoc) || hasAny(blob, KEYWORDS.photoDoc)) {
      return { ok: false, problem: true, reason: 'المرفق المصنف سيرة ذاتية يبدو أنه مستند آخر' }
    }
    return { ok: false, problem: false, reason: 'لم يظهر دليل كافٍ على أنه سيرة ذاتية' }
  }

  const readable = f.textSnippet.length >= 30 || !!f.ocrRead?.readable
  return { ok: readable, problem: false, reason: readable ? 'مرفق قابل للقراءة' : 'غير قابل للتحقق آلياً' }
}

function fileDetail(f: AdmissionFileEvidence, extra?: string): string {
  const base = `مرفوع (${f.fileName} — ${Math.ceil(f.size / 1024)}ك.ب)`
  const read = f.textSnippet.length >= 30
    ? ` — تمت قراءة المحتوى آلياً (${f.textReader})`
    : f.ocrRead
      ? ` — نتيجة الرؤية: ${f.ocrRead.docTypeDetected || 'غير محدد'}${f.ocrRead.qualityNote ? ` — ${f.ocrRead.qualityNote}` : ''}`
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
    const candidates = app.files.filter((f) => f.docType === type)
    if (candidates.length === 0) {
      checklist.push({ requirement: label, status: 'MISSING', detail: 'لم يُرفع هذا المستند (مطلوب وفق قواعد قبول البرنامج)' })
      hardProblems++
      continue
    }

    const evaluated = candidates.map((f) => ({ f, match: expectedDocMatches(type, f) }))
    const good = evaluated.find((x) => x.match.ok)
    const bad = evaluated.find((x) => x.match.problem)

    if (good) {
      requiredFound++
      if (type !== 'PHOTO') docTextFound = true
      checklist.push({ requirement: label, status: 'FOUND', detail: fileDetail(good.f, good.match.reason) })
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

  const degreeFiles = app.files.filter((f) => f.docType === 'DEGREE')
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
      if (f.mimeType.startsWith('image/') && visionReads < MAX_VISION_FILES) {
        visionReads++
        ocrRead = await readDocumentImage(buf, f.mimeType, f.docType, DOC_TYPE_AR[f.docType] || f.docType)
        textSnippet = ocrRead?.extractedText || ''
        textReader = 'IMAGE'
        textNote = ocrRead ? (ocrRead.readable ? 'تمت قراءة الصورة بالرؤية الذكية' : `الصورة غير مقبولة آلياً: ${ocrRead.docTypeDetected || ocrRead.qualityNote}`) : 'تعذر فحص الصورة بالرؤية الذكية'
      } else if (textReads < MAX_TEXT_EVIDENCE_FILES) {
        textReads++
        const extracted = await extractDocumentText(buf, f.mimeType, f.fileName, 12000)
        textSnippet = extracted.text
        textReader = extracted.reader
        textNote = extracted.note
      }
    }

    out.push({
      docType: f.docType,
      fileName: f.fileName,
      mimeType: f.mimeType || 'application/octet-stream',
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
    const match = expectedDocMatches(f.docType, f)
    const text = (f.textSnippet || f.ocrRead?.extractedText || '').replace(/\s+/g, ' ').slice(0, 1000)
    return `ملف ${i + 1}: التصنيف=${label}; الاسم=${f.fileName}; النوع=${f.mimeType}; الحجم=${Math.ceil(f.size / 1024)}ك.ب; القارئ=${f.textReader}; نتيجة المطابقة=${match.ok ? 'مطابق' : match.problem ? 'مشكلة' : 'غير متحقق'}; السبب=${match.reason}; ملاحظة القراءة=${f.textNote}; مقتطف=${text || '-'}`
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
