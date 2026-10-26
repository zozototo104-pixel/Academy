import { getDefaultRequiredServiceDocumentTypes, getServiceDocumentOptions, getServiceFlow } from '@/lib/service-flows'

export type AdmissionDocumentOption = { type: string; label: string }
export type AdmissionRulesLike = { requiredDocuments?: string[] | null; customDocuments?: AdmissionDocumentOption[] | null }

// الوثائق الرسمية الافتراضية لطلبات الوكالة والاعتماد (تُقرأ من قواعد
// الوكالة والاعتماد عند وجودها، وإلا تُستخدم هذه القائمة الابتدائية).
export const DEFAULT_AGENT_DOCS: AdmissionDocumentOption[] = [
  { type: 'LICENSE', label: 'صورة عن شهادة الترخيص أو مزاولة المهنة' },
  { type: 'ID', label: 'صورة عن الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة (للمدربين / المستشارين)' },
  { type: 'CV', label: 'صورة عن السيرة الذاتية C.V' },
]

export function parseAgentRules(raw: unknown): AdmissionRulesLike | null {
  const parsed = parseAdmissionRules(raw)
  if (!parsed) return null
  return parsed
}

// قواعد مرفقات الوكالة/الاعتماد: قائمة مشتركة للنوعين، تُضبط من تبويب
// قواعد القبول (نطاق الوكالة والاعتماد) — تفعيل وثيقة يجعلها إجبارية،
// والمرفقات المخصصة تُحمل أسماءها معها فلا تسقط التسمية أبداً.
export function resolveAgentRequiredDocuments(rawRules: unknown): { requiredDocs: AdmissionDocumentOption[]; customDocs: AdmissionDocumentOption[] } {
  const rules = parseAgentRules(rawRules)
  const customDocs = Array.isArray(rules?.customDocuments)
    ? rules!.customDocuments.filter((d) => d && typeof d.type === 'string' && typeof d.label === 'string' && d.type && d.label).slice(0, 10)
    : []
  const known = new Map([...DEFAULT_AGENT_DOCS, ...customDocs].map((d) => [d.type, d] as const))
  const explicit = Array.isArray(rules?.requiredDocuments) ? rules!.requiredDocuments.filter(Boolean) : []
  const types = explicit.length ? explicit : DEFAULT_AGENT_DOCS.map((d) => d.type)
  return {
    requiredDocs: types.map((type) => known.get(type) || { type, label: type }),
    customDocs,
  }
}

export function parseAdmissionRules(raw: unknown): AdmissionRulesLike | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      const parsed = JSON.parse(trimmed)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AdmissionRulesLike : null
    } catch {
      return null
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw as AdmissionRulesLike : null
}

export const REQUIRED_ADMISSION_DOCS: AdmissionDocumentOption[] = [
  { type: 'DEGREE', label: 'صورة عن الشهادة الجامعية وكشف العلامات (أو الثانوية للدبلومات)' },
  { type: 'ID', label: 'صورة عن الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة' },
  { type: 'CV', label: 'صورة عن السيرة الذاتية (C.V)' },
]

export const SERVICE_REQUEST_DOCS: AdmissionDocumentOption[] = [
  { type: 'ID', label: 'الهوية الشخصية أو جواز السفر عند الحاجة' },
  { type: 'CV', label: 'السيرة الذاتية أو نبذة عن الخبرة' },
  { type: 'SERVICE_FILE', label: 'ملف يوضح الاحتياج أو الوثائق الداعمة للخدمة' },
]

export const EXTRA_ADMISSION_DOCS: AdmissionDocumentOption[] = [
  { type: 'EXPERIENCE', label: 'إثبات خبرات عملية' },
  { type: 'TRANSCRIPT', label: 'كشف درجات منفصل' },
]

export function resolveAdmissionRequiredDocuments(input: {
  slug?: string | null
  category?: string | null
  admissionRules?: unknown
  isServiceRequest?: boolean | null
}) {
  const flow = getServiceFlow(input.slug || undefined)
  const serviceDocs = getServiceDocumentOptions(flow).map((d) => ({ type: d.type, label: d.label }))
  const admissionRules = parseAdmissionRules(input.admissionRules)
  // المرفقات المخصصة من قواعد القبول: تدخل خريطة التسميات أولاً حتى
  // تظهر باسمها الحقيقي في النماذج ورسائل النقص، لا برمزها.
  const customDocs = Array.isArray(admissionRules?.customDocuments)
    ? admissionRules!.customDocuments.filter((d) => d && typeof d.type === 'string' && typeof d.label === 'string' && d.type && d.label).slice(0, 10)
    : []
  const allKnownDocs = [...REQUIRED_ADMISSION_DOCS, ...SERVICE_REQUEST_DOCS, ...EXTRA_ADMISSION_DOCS, ...serviceDocs, ...customDocs]
  const docLabelMap = new Map(allKnownDocs.map((doc) => [doc.type, doc] as const))
  const explicitTypes = Array.isArray(admissionRules?.requiredDocuments)
    ? admissionRules.requiredDocuments.filter(Boolean)
    : []
  const hasExplicitRequiredDocuments = explicitTypes.length > 0
  const isServiceRequest = input.isServiceRequest ?? (flow ? !flow.isStudyProgram : input.category === 'SERVICE')
  const defaultServiceRequired = getDefaultRequiredServiceDocumentTypes(flow)
  const requiredTypes = hasExplicitRequiredDocuments
    ? explicitTypes
    : isServiceRequest
      ? defaultServiceRequired
      : REQUIRED_ADMISSION_DOCS.map((doc) => doc.type)
  const requiredDocs = requiredTypes.map((type) => docLabelMap.get(type) || { type, label: type })
  const activeDocs = hasExplicitRequiredDocuments
    ? requiredDocs
    : flow
      ? (serviceDocs.length ? serviceDocs : SERVICE_REQUEST_DOCS)
      : isServiceRequest
        ? SERVICE_REQUEST_DOCS
        : REQUIRED_ADMISSION_DOCS
  return { requiredDocs, activeDocs, allKnownDocs }
}
