import { db } from '@/lib/db'

// ===== إعدادات المنصة القابلة للتعديل من لوحة التحكم بدون كود =====
// القيم الافتراضية مأخوذة حرفياً من دليل إجراءات وشروط الالتحاق وعقد التمثيل الدولي

export interface SettingDef {
  key: string
  value: string
  label: string
  group: string // FEES | RULES
  suffix: string // $ | يوم | شهر | %
}

export const DEFAULT_SETTINGS: SettingDef[] = [
  // الرسوم (دليل الإجراءات)
  { key: 'FEE_APPLICATION', value: '30', label: 'رسوم التقديم وحجز المقعد (غير مستردة)', group: 'FEES', suffix: '$' },
  { key: 'FEE_DOCTORATE', value: '1300', label: 'الدكتوراة المهنية (معادلة خبرات)', group: 'FEES', suffix: '$' },
  { key: 'FEE_MASTERS', value: '700', label: 'الماجستير المهني (معادلة خبرات)', group: 'FEES', suffix: '$' },
  { key: 'FEE_DIPLOMAS_MIN', value: '100', label: 'الدبلومات والبرامج الدولية — من', group: 'FEES', suffix: '$' },
  { key: 'FEE_DIPLOMAS_MAX', value: '350', label: 'الدبلومات والبرامج الدولية — إلى', group: 'FEES', suffix: '$' },
  { key: 'FEE_ACC_APPLICATION', value: '100', label: 'رسوم تقديم طلب الاعتماد (غير مستردة)', group: 'FEES', suffix: '$' },
  { key: 'FEE_ACC_COMPANY', value: '1000', label: 'اعتماد هيئات تدريبية (شركات/مؤسسات/مراكز)', group: 'FEES', suffix: '$' },
  { key: 'FEE_ACC_CONSULTANT', value: '350', label: 'اعتماد المستشارين (بجميع التخصصات)', group: 'FEES', suffix: '$' },
  { key: 'FEE_ACC_TRAINER', value: '200', label: 'اعتماد مدرب دولي معتمد', group: 'FEES', suffix: '$' },
  // القواعد والمهل الزمنية
  { key: 'AGENT_COMMISSION_RATE', value: '25', label: 'نسبة عمولة الوكيل من إيرادات البرامج', group: 'RULES', suffix: '%' },
  { key: 'COMMITTEE_MEMBER_FEE', value: '100', label: 'مستحقات عضو لجنة المناقشة من الوكيل لكل بحث', group: 'RULES', suffix: '$' },
  { key: 'CERTIFICATE_ISSUE_DAYS', value: '30', label: 'المدة القصوى لإصدار الشهادة من استلام كشوف الدرجات والرسوم', group: 'RULES', suffix: 'يوماً' },
  { key: 'THESIS_MIN_MONTHS', value: '3', label: 'الحد الأدنى لتقديم ومناقشة بحث التخرج', group: 'RULES', suffix: 'أشهر' },
  { key: 'THESIS_MAX_MONTHS', value: '6', label: 'الحد الأقصى لتقديم ومناقشة بحث التخرج', group: 'RULES', suffix: 'أشهر' },
  { key: 'TRANSFER_DUE_DAYS', value: '14', label: 'مهلة تحويل المستحقات المالية للأكاديمية من تاريخ طلب إصدار الشهادات', group: 'RULES', suffix: 'يوماً' },
  { key: 'CONTRACT_RENEW_NOTICE_DAYS', value: '30', label: 'فترة إشعار عدم تجديد عقد الوكالة (30-60 يوماً)', group: 'RULES', suffix: 'يوماً' },
]

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany()
  const map: Record<string, string> = {}
  for (const def of DEFAULT_SETTINGS) map[def.key] = def.value
  for (const r of rows) map[r.key] = r.value
  return map
}

export async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? DEFAULT_SETTINGS.find((d) => d.key === key)?.value ?? ''
}

export async function getSettingNum(key: string): Promise<number> {
  const v = await getSetting(key)
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

// توليد أرقام فريدة متسلسلة
function pad(n: number, len = 4): string {
  return String(n).padStart(len, '0')
}

export async function nextSerial(prefix: string): Promise<string> {
  const year = new Date().getFullYear()
  const base = `${prefix}-${year}-`
  const count =
    (await db.certificate.count()) +
    (await db.payment.count()) +
    (await db.admissionApplication.count()) +
    1
  return `${base}${pad(count)}`
}

export async function nextInvoiceNo(): Promise<string> {
  const c = await db.payment.count()
  return `AACT-INV-${new Date().getFullYear()}-${pad(c + 1)}`
}

export async function nextReceiptNo(): Promise<string> {
  const paid = await db.payment.count({ where: { status: 'PAID' } })
  return `AACT-REC-${new Date().getFullYear()}-${pad(paid + 1)}`
}

export async function nextCertSerial(): Promise<string> {
  const c = await db.certificate.count()
  return `AACT-C-${new Date().getFullYear()}-${pad(c + 1, 5)}`
}

export async function nextContractNo(): Promise<string> {
  const c = await db.agentApplication.count({ where: { contractNo: { not: null } } })
  return `AACT-AG-${new Date().getFullYear()}-${pad(c + 1, 3)}`
}

export async function nextAdmissionRef(): Promise<string> {
  const c = await db.admissionApplication.count()
  return `AACT-${new Date().getFullYear()}-${1000 + c + 1}`
}
