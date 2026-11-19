// مسودة نموذج الوكالة/الاعتماد — نصوص النموذج ومفاتيح الملفات المرحّلة،
// كلٌّ في مفتاح مستقل حتى لا يكتب أحدهما فوق الآخر:
// - نصوص النموذج تُحفظ عند بوابة الدخول فقط (كما كان)، وتُقرأ عند العودة.
// - مفاتيح الملفات المرحّلة (stagedDocs) نصوص فتنجو من تحديث الصفحة،
//   وتُحفظ عند كل ترحيل ناجح أو استبدال، وتُمسح عند نجاح الطلب.
// - لكل حساب مساحته الخاصة، والضيف منفصل حتى يعود من شاشة الدخول.
// الملفات نفسها لا تُحفظ هنا (File لا يُسلسل) — الملتقَطة قبل الدخول
// يحفظها agent-pending-files في الذاكرة لرحلة الدخول داخل الصفحة نفسها.

const AGENT_DRAFT_KEY = 'aact-agent-draft'
const AGENT_STAGED_KEY = 'aact-agent-staged'

// Each authenticated account gets its own browser namespace. The old shared
// keys are discarded rather than guessed to belong to the next account.
function scopedKey(base: string, userId?: string | null) {
  return `${base}:${userId ? encodeURIComponent(userId) : 'guest'}`
}

function discardUnscopedKeys() {
  localStorage.removeItem(AGENT_DRAFT_KEY)
  localStorage.removeItem(AGENT_STAGED_KEY)
}

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

export function readAgentDraft(userId?: string | null): AgentDraft | null {
  if (typeof localStorage === 'undefined') return null
  try {
    discardUnscopedKeys()
    const raw = localStorage.getItem(scopedKey(AGENT_DRAFT_KEY, userId))
    if (!raw) return null
    const draft = JSON.parse(raw)
    return draft && typeof draft === 'object' ? draft : null
  } catch (e) {
    console.warn('Failed to read saved agent draft.', e)
    return null
  }
}

export function saveAgentDraft(draft: AgentDraft, userId?: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    discardUnscopedKeys()
    localStorage.setItem(scopedKey(AGENT_DRAFT_KEY, userId), JSON.stringify(draft))
  } catch (e) {
    console.warn('Failed to save agent draft.', e)
  }
}

export function clearAgentDraft(userId?: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    discardUnscopedKeys()
    localStorage.removeItem(scopedKey(AGENT_DRAFT_KEY, userId))
  } catch (e) {
    console.warn('Failed to clear agent draft.', e)
  }
}

export function readAgentStagedDocs(userId?: string | null): AgentStagedDoc[] {
  if (typeof localStorage === 'undefined') return []
  try {
    discardUnscopedKeys()
    const raw = localStorage.getItem(scopedKey(AGENT_STAGED_KEY, userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d: any) => d && typeof d.docType === 'string' && typeof d.storageKey === 'string')
  } catch (e) {
    console.warn('Failed to read staged agent docs.', e)
    return []
  }
}

export function saveAgentStagedDocs(docs: AgentStagedDoc[], userId?: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    discardUnscopedKeys()
    const key = scopedKey(AGENT_STAGED_KEY, userId)
    if (docs.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(docs))
  } catch (e) {
    console.warn('Failed to save staged agent docs.', e)
  }
}

export function clearAgentStagedDocs(userId?: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    discardUnscopedKeys()
    localStorage.removeItem(scopedKey(AGENT_STAGED_KEY, userId))
  } catch (e) {
    console.warn('Failed to clear staged agent docs.', e)
  }
}

// Called only after the user intentionally logs in from the guest agent form.
// Guest drafts may cross the login boundary, but never between signed-in users.
export function adoptGuestAgentDraft(userId: string) {
  const guestDraft = readAgentDraft()
  const guestDocs = readAgentStagedDocs()
  if (guestDraft) saveAgentDraft(guestDraft, userId)
  if (guestDocs.length) saveAgentStagedDocs(guestDocs, userId)
  clearAgentDraft()
  clearAgentStagedDocs()
}
