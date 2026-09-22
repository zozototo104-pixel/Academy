export const DELIVERABLE_TYPE_LABEL: Record<string, string> = {
  CERTIFICATE_PDF: 'شهادة PDF',
  EQUIVALENCY_CERTIFICATE: 'شهادة معادلة',
  PACKAGE_DOWNLOAD: 'تحميل حقيبة تدريبية',
  CONSULTATION_LINK: 'رابط جلسة استشارية',
  CONSULTATION_REPORT: 'تقرير استشارة',
  MEMBERSHIP_CARD: 'بطاقة عضوية',
  ACCREDITATION_CERTIFICATE: 'شهادة اعتماد',
  CUSTOM_PACKAGE_DRAFT: 'مسودة حقيبة مخصصة',
  CUSTOM_PACKAGE_FINAL: 'التسليم النهائي للحقيبة',
  OTHER: 'مخرج آخر',
}

export const DELIVERABLE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'مسودة',
  PUBLISHED: 'منشور للعميل',
  REVOKED: 'ملغى',
}

export function deliverableTypeLabel(type?: string | null): string {
  return DELIVERABLE_TYPE_LABEL[String(type || '')] || String(type || 'مخرج خدمة')
}

export function deliverableStatusLabel(status?: string | null): string {
  return DELIVERABLE_STATUS_LABEL[String(status || '')] || String(status || 'غير محدد')
}

export function normalizeDeliverableType(type?: string | null): string {
  const value = String(type || '').trim().toUpperCase()
  return DELIVERABLE_TYPE_LABEL[value] ? value : 'OTHER'
}

export function isDeliverablePublished(status?: string | null, visible?: boolean | null): boolean {
  return String(status || 'PUBLISHED') === 'PUBLISHED' && visible !== false
}
