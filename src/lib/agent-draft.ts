// مسودة نموذج الوكالة/الاعتماد — نصوص النموذج ومفاتيح الملفات المرحّلة،
// كلٌّ في مفتاح مستقل حتى لا يكتب أحدهما فوق الآخر:
// - نصوص النموذج تُحفظ عند بوابة الدخول فقط (كما كان)، وتُقرأ عند العودة.
// - مفاتيح الملفات المرحّلة (stagedDocs) نصوص فتنجو من تحديث الصفحة،
//   وتُحفظ عند كل ترحيل ناجح أو استبدال، وتُمسح عند نجاح الطلب.
// الملفات نفسها لا تُحفظ هنا (File لا يُسلسل) — الملتقَطة قبل الدخول
// يحفظها agent-pending-files في الذاكرة لرحلة الدخول داخل الصفحة نفسها.

const AGENT_DRAFT_KEY = 'aact-agent-draft'
const AGENT_STAGED_KEY = 'aact-agent-staged'

export type AgentStagedDoc = {
  docType: string
  storageKey: string
  uploadToken: string
  fileUrl: string
  fileName: string
  mimeType: string
  size: number
}

export type AgentDraft = {
  form?: Record<string, string>
  kind?: string
  accreditationType?: string
}

export function readAgentDraft(): AgentDraft | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(AGENT_DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw)
    return draft && typeof draft === 'object' ? draft : null
  } catch (e) {
    console.warn('Failed to read saved agent draft.', e)
    return null
  }
}

export function saveAgentDraft(draft: AgentDraft) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(AGENT_DRAFT_KEY, JSON.stringify(draft))
  } catch (e) {
    console.warn('Failed to save agent draft.', e)
  }
}

export function clearAgentDraft() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(AGENT_DRAFT_KEY)
  } catch (e) {
    console.warn('Failed to clear agent draft.', e)
  }
}

export function readAgentStagedDocs(): AgentStagedDoc[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(AGENT_STAGED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d: any) => d && typeof d.docType === 'string' && typeof d.storageKey === 'string')
  } catch (e) {
    console.warn('Failed to read staged agent docs.', e)
    return []
  }
}

export function saveAgentStagedDocs(docs: AgentStagedDoc[]) {
  if (typeof localStorage === 'undefined') return
  try {
    if (docs.length === 0) localStorage.removeItem(AGENT_STAGED_KEY)
    else localStorage.setItem(AGENT_STAGED_KEY, JSON.stringify(docs))
  } catch (e) {
    console.warn('Failed to save staged agent docs.', e)
  }
}

export function clearAgentStagedDocs() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(AGENT_STAGED_KEY)
  } catch (e) {
    console.warn('Failed to clear staged agent docs.', e)
  }
}
