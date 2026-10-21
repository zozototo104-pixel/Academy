export function arabicAiStatusMessage(codeOrError: unknown): string {
  const raw = String(codeOrError || '').trim()
  const code = raw.toUpperCase()
  if (/AI_ACADEMIC_PROVIDER_UNAVAILABLE|NO_PROVIDER/.test(code)) return 'توقف مؤقتاً: كل النماذج المسموحة غير متاحة حالياً. سنكمل تلقائياً بعد 5 دقائق.'
  if (/NO_BALANCE|\b402\b/.test(code)) return 'انتهى رصيد أو حصة أحد المزوّدين. سنجرّب مزوّداً آخر.'
  if (/\b429\b|DAILY[_\s-]*CAP|DAILY CAP|PER\s*DAY|USAGE.*DAILY/.test(code)) return 'تم الوصول لحد الاستخدام اليومي لهذا النموذج.'
  if (/COOLDOWN|تبريد/.test(code)) return 'النموذج في فترة تبريد مؤقتة بعد خطأ، سيُعاد تجربته تلقائياً.'
  if (/TIMEOUT|DEADLINE/.test(code)) return 'استغرق النموذج وقتاً أطول من المسموح، سنكمل بالدفعة التالية.'
  if (/MODEL_DEAD|\b404\b/.test(code)) return 'النموذج متوقف من المزوّد وتم تعطيله.'
  if (/\b401\b|\b403\b|AUTH|UNAUTH|FORBIDDEN|PERMISSION|INVALID\s*KEY|API\s*KEY/.test(code)) return 'مفتاح المزوّد غير صالح، راجع الإعدادات.'
  if (/VERIFICATIONPENDING|VERIFICATION_PENDING|PENDING_REVIEW/.test(code)) return 'لم يتوفر مدقّق الآن، الأسئلة محفوظة بانتظار المراجعة.'
  return 'تعذّر إكمال الخطوة. سنحاول مرة أخرى.'
}

export function aiProgressPercent(processed: unknown, total: unknown): number | null {
  const totalCount = Math.max(0, Number(total || 0) || 0)
  if (!totalCount) return null
  const processedCount = Math.max(0, Number(processed || 0) || 0)
  return Math.max(0, Math.min(100, Math.round((processedCount / totalCount) * 100)))
}

export function aiProgressLabel(processed: unknown, total: unknown): string {
  const percent = aiProgressPercent(processed, total)
  return percent == null ? 'جارٍ التحضير…' : `${percent}%`
}
