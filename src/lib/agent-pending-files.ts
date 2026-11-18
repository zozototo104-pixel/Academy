// الملفات الملتقَطة قبل الدخول — File لا يعيش في localStorage، فتُحفظ
// هذه الملفات في ذاكرة الصفحة (Map على مستوى الوحدة) لتنجو من رحلة
// الدخول والعودة داخل الصفحة نفسها (بلا تحديث للصفحة): الضيف يلتقط
// ملفاته، يذهب لشاشة الدخول، يعود إلى النموذج نفسه فيجد ملفاته كما هي،
// فتُرحَّل تلقائياً بعد الدخول. تُمسح عند نجاح الطلب. تحديث الصفحة
// يفقدها (مفاتيح الملفات المرحّلة وحدها تنجو عبر agent-draft).

const held = new Map<string, File>()

export function getPendingAgentFiles(): Record<string, File> {
  const out: Record<string, File> = {}
  for (const [type, file] of held) out[type] = file
  return out
}

export function setPendingAgentFile(type: string, file: File | null) {
  if (file) held.set(type, file)
  else held.delete(type)
}

export function clearPendingAgentFiles() {
  held.clear()
}
