// مؤشر «عودة إلى النموذج بعد الدخول» — يُحفظ في متصفح المستخدم نفسه
// (localStorage لأنه يجب أن ينجو من رحلة تأكيد البريد وتسجيل الدخول
// عبر تبويبات مختلفة). يضبطه نموذج الوكالة/الاعتماد أو نموذج الالتحاق
// قبل الانتقال لشاشة الدخول، وتقرأه شاشة الدخول بعد نجاح الدخول أو
// التسجيل فتعيد المستخدم إلى نموذجه بدل لوحته. بلا مؤشر يبقى السلوك
// كما هو: الدخول العادي يذهب إلى اللوحة. صلاحية المؤشر 24 ساعة، ويُمسح
// عند استعماله. (مرحلة 2 — إصلاح دخول /agent — 2026-11-18)

const KEY = 'aact_pending_return_view'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export type PendingReturnView = 'agent' | 'apply'

function isPendingReturnView(value: unknown): value is PendingReturnView {
  return value === 'agent' || value === 'apply'
}

export function setPendingReturnView(view: PendingReturnView) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ view, at: Date.now() }))
  } catch { /* ignore */ }
}

export function peekPendingReturnView(): PendingReturnView | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!isPendingReturnView(parsed?.view) || Date.now() - Number(parsed.at || 0) > MAX_AGE_MS) {
      localStorage.removeItem(KEY)
      return null
    }
    return parsed.view
  } catch {
    return null
  }
}

export function clearPendingReturnView() {
  try {
    localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}
