// مؤشر «دعوة اجتماع بانتظار الإكمال» — يُحفظ في متصفح الضيف نفسه
// (localStorage لأنه يجب أن ينجو من رحلة تأكيد البريد وتسجيل الدخول
// عبر تبويبات مختلفة). الرمز نفسه ليس سرًا إضافيًا: رابط الدعوة هو
// الاعتماد أصلًا ويتنقّل بالرسائل. صلاحية المؤشر 24 ساعة، ويُمسح
// عند إتمام الاستلام. يستعمله: صفحة الدعوة (ضبطًا واستلامًا
// تلقائيًا) وشاشتا الدخول (العودة بالضيف إلى اجتماعه بعد الدخول).

const KEY = 'aact_pending_meeting_invite'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function setPendingMeetingInvite(token: string) {
  try {
    if (token) localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() }))
  } catch { /* ignore */ }
}

export function peekPendingMeetingInvite(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.token || Date.now() - Number(parsed.at || 0) > MAX_AGE_MS) {
      localStorage.removeItem(KEY)
      return null
    }
    return String(parsed.token)
  } catch {
    return null
  }
}

export function clearPendingMeetingInvite() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}
