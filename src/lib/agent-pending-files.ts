// الملفات الملتقَطة قبل الدخول — File لا يعيش في localStorage، فتُحفظ
// هذه الملفات في ذاكرة الصفحة (Map معزول حسب الحساب/الضيف) لتنجو من رحلة
// الدخول والعودة داخل الصفحة نفسها (بلا تحديث للصفحة): الضيف يلتقط
// ملفاته، يذهب لشاشة الدخول، يعود إلى النموذج نفسه فيجد ملفاته كما هي،
// فتُرحَّل تلقائياً بعد الدخول. تُمسح عند نجاح الطلب. تحديث الصفحة
// يفقدها (مفاتيح الملفات المرحّلة وحدها تنجو عبر agent-draft).
// لا تنتقل ملفات حساب إلى حساب آخر، وتمسح ملفات الحساب عند خروجه.

const held = new Map<string, Map<string, File>>()

function filesFor(userId?: string | null) {
  const key = userId || 'guest'
  if (!held.has(key)) held.set(key, new Map())
  return held.get(key)!
}

export function getPendingAgentFiles(userId?: string | null): Record<string, File> {
  const out: Record<string, File> = {}
  for (const [type, file] of filesFor(userId)) out[type] = file
  return out
}

export function setPendingAgentFile(type: string, file: File | null, userId?: string | null) {
  if (file) filesFor(userId).set(type, file)
  else filesFor(userId).delete(type)
}

export function clearPendingAgentFiles(userId?: string | null) {
  held.delete(userId || 'guest')
}

export function adoptGuestAgentFiles(userId: string) {
  const guest = held.get('guest')
  if (guest?.size) held.set(userId, new Map(guest))
  held.delete('guest')
}
