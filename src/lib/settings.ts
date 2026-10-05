import { db } from '@/lib/db'

// ===== إعدادات المنصة القابلة للتعديل من لوحة التحكم بدون كود =====
// القيم الافتراضية مأخوذة من دليل إجراءات وشروط الالتحاق وعقد التمثيل الدولي.

export interface SettingDef {
  key: string
  value: string
  label: string
  group: string // FEES | RULES | AI | CONTENT | CONTACT
  suffix: string // $ | يوم | شهر | % | دقيقة
  inputType?: 'number' | 'text' | 'textarea' | 'json'
  help?: string
}

export const DEFAULT_HOME_STATS = { graduates: 2000, experts: 120, countries: 18 }

export const DEFAULT_OFFICIAL_CONTACT = {
  legalEntity: 'الأكاديمية الأمريكية للاستشارات والتدريب',
  registrationNumber: '',
  address: 'الولايات المتحدة الأمريكية - ولاية وايومنغ',
  email: 'info@americanacademy.com',
  phone: '+1 (307) 206-5544',
  phones: ['+1 (307) 206-5544'],
  whatsapp: '+17879684281',
  whatsapps: ['+17879684281'],
  responsiblePerson: 'د. أحمد معروف "أبو البراء"',
}

export const DEFAULT_DISCLOSURE_CONSENT_TEXT = 'أقر بأن البيانات والوثائق المقدمة صحيحة، وأوافق على شروط الأكاديمية وسداد رسوم التقديم غير المستردة، ثم سداد الرسوم الدراسية بعد القبول وفق سياسة البرنامج.'

export const DEFAULT_TRUST_BANNER_TEXT = 'برامج تدريب مهني تصدر شهاداتها عن الأكاديمية الأمريكية للاستشارات والتدريب، وقبولها يعود لجهة العمل أو الجهة المختصة.'

export const DEFAULT_SETTINGS: SettingDef[] = [
  // الرسوم العامة: أسعار البرامج الافتراضية فقط، أما سعر كل برنامج فيُعدل من قواعد القبول.
  { key: 'FEE_APPLICATION', value: '30', label: 'رسوم التقديم وحجز المقعد (غير مستردة)', group: 'FEES', suffix: '$', inputType: 'number' },
  { key: 'FEE_DOCTORATE', value: '1300', label: 'سعر الدكتوراه الافتراضي (يُستخدم فقط للبرامج بدون سعر)', group: 'FEES', suffix: '$', inputType: 'number', help: 'سعر كل برنامج يُعدّل من قواعد القبول.' },
  { key: 'FEE_MASTERS', value: '700', label: 'سعر الماجستير الافتراضي (يُستخدم فقط للبرامج بدون سعر)', group: 'FEES', suffix: '$', inputType: 'number', help: 'سعر كل برنامج يُعدّل من قواعد القبول.' },
  { key: 'FEE_DIPLOMAS_MIN', value: '100', label: 'نطاق الدبلومات الافتراضي — من (يُستخدم فقط للبرامج بدون سعر)', group: 'FEES', suffix: '$', inputType: 'number', help: 'سعر كل برنامج يُعدّل من قواعد القبول.' },
  { key: 'FEE_DIPLOMAS_MAX', value: '350', label: 'نطاق الدبلومات الافتراضي — إلى (يُستخدم فقط للبرامج بدون سعر)', group: 'FEES', suffix: '$', inputType: 'number', help: 'سعر كل برنامج يُعدّل من قواعد القبول.' },
  { key: 'FEE_ACC_APPLICATION', value: '100', label: 'رسوم تقديم طلب الاعتماد (غير مستردة)', group: 'FEES', suffix: '$', inputType: 'number' },
  { key: 'FEE_ACC_COMPANY', value: '1000', label: 'اعتماد هيئات تدريبية (شركات/مؤسسات/مراكز)', group: 'FEES', suffix: '$', inputType: 'number' },
  { key: 'FEE_ACC_CONSULTANT', value: '350', label: 'اعتماد المستشارين (بجميع التخصصات)', group: 'FEES', suffix: '$', inputType: 'number' },
  { key: 'FEE_ACC_TRAINER', value: '200', label: 'اعتماد مدرب دولي معتمد', group: 'FEES', suffix: '$', inputType: 'number' },
  { key: 'FEE_SERVICE_DEFAULT', value: '50', label: 'رسوم الخدمة المهنية الافتراضية (تُستخدم فقط للخدمات بدون سعر)', group: 'FEES', suffix: '$', inputType: 'number', help: 'سعر كل خدمة أو برنامج يُعدّل من قواعد القبول.' },

  // باقات الذكاء الاصطناعي — تبيع المنصة دقائق محادثة صوتية للطلاب بعد انتهاء الرصيد المجاني
  { key: 'AI_LIVE_PACKAGE_MINUTES', value: '60', label: 'عدد دقائق باقة المحادثة الصوتية الإضافية', group: 'AI', suffix: 'دقيقة', inputType: 'number' },
  { key: 'AI_LIVE_PACKAGE_PRICE_USD', value: '10', label: 'سعر باقة دقائق المحادثة الصوتية', group: 'AI', suffix: '$', inputType: 'number' },

  // القواعد والمهل الزمنية
  { key: 'AGENT_COMMISSION_RATE', value: '25', label: 'نسبة عمولة الوكيل من إيرادات البرامج', group: 'RULES', suffix: '%', inputType: 'number' },
  { key: 'COMMITTEE_MEMBER_FEE', value: '100', label: 'مستحقات عضو لجنة المناقشة من الوكيل لكل بحث', group: 'RULES', suffix: '$', inputType: 'number' },
  { key: 'CERTIFICATE_ISSUE_DAYS', value: '30', label: 'المدة القصوى لإصدار الشهادة من استلام كشوف الدرجات والرسوم', group: 'RULES', suffix: 'يوماً', inputType: 'number' },
  { key: 'THESIS_MIN_MONTHS', value: '3', label: 'الحد الأدنى لتقديم ومناقشة بحث التخرج', group: 'RULES', suffix: 'أشهر', inputType: 'number' },
  { key: 'THESIS_MAX_MONTHS', value: '6', label: 'الحد الأقصى لتقديم ومناقشة بحث التخرج', group: 'RULES', suffix: 'أشهر', inputType: 'number' },
  { key: 'TRANSFER_DUE_DAYS', value: '14', label: 'مهلة تحويل المستحقات المالية للأكاديمية من تاريخ طلب إصدار الشهادات', group: 'RULES', suffix: 'يوماً', inputType: 'number' },
  { key: 'CONTRACT_RENEW_NOTICE_DAYS', value: '30', label: 'فترة إشعار عدم تجديد عقد الوكالة (30-60 يوماً)', group: 'RULES', suffix: 'يوماً', inputType: 'number' },

  // محتوى عام يظهر في الواجهات العامة
  { key: 'DISCLOSURE_CONSENT_TEXT', value: DEFAULT_DISCLOSURE_CONSENT_TEXT, label: 'نص الإقرار العام قبل الدفع', group: 'CONTENT', suffix: '', inputType: 'textarea', help: 'يستخدم إذا لم يحدد البرنامج نص إقرار خاصاً من قواعد القبول.' },
  { key: 'TRUST_BANNER_TEXT', value: DEFAULT_TRUST_BANNER_TEXT, label: 'نص شريط الثقة في الرئيسية', group: 'CONTENT', suffix: '', inputType: 'textarea' },
  { key: 'HOME_STATS', value: JSON.stringify(DEFAULT_HOME_STATS), label: 'إحصائيات الرئيسية', group: 'CONTENT', suffix: '', inputType: 'json', help: 'JSON: graduates, experts, countries' },

  // بيانات التواصل الرسمية
  { key: 'OFFICIAL_CONTACT', value: JSON.stringify(DEFAULT_OFFICIAL_CONTACT), label: 'بيانات التواصل الرسمية', group: 'CONTACT', suffix: '', inputType: 'json', help: 'JSON: legalEntity, registrationNumber, address, email, phone, whatsapp, responsiblePerson' },
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

export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await getSetting(key)
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function getHomeStats() {
  return getSettingJson('HOME_STATS', DEFAULT_HOME_STATS)
}

export async function getOfficialContact() {
  return getSettingJson('OFFICIAL_CONTACT', DEFAULT_OFFICIAL_CONTACT)
}

// توليد أرقام فريدة متسلسلة
function pad(n: number, len = 4): string {
  return String(n).padStart(len, '0')
}

function invoiceSequence(invoiceNo: string, prefix: string): number {
  if (!invoiceNo.startsWith(prefix)) return 0
  const n = Number(invoiceNo.slice(prefix.length))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
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
  const year = new Date().getFullYear()
  const prefix = `AACT-INV-${year}-`
  const rows = await db.payment.findMany({
    where: { invoiceNo: { startsWith: prefix } },
    select: { invoiceNo: true },
  })
  let next = rows.reduce((max, row) => Math.max(max, invoiceSequence(row.invoiceNo, prefix)), 0) + 1

  // لا نعتمد على عدد السجلات لأن تنظيف بيانات QA أو حذف فواتير قديمة يخلق فجوات.
  // نفحص الوجود فعلياً حتى لا نصطدم بقيد invoiceNo الفريد في قاعدة البيانات.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = `${prefix}${pad(next + attempt)}`
    const exists = await db.payment.findUnique({ where: { invoiceNo: candidate }, select: { id: true } })
    if (!exists) return candidate
  }

  throw new Error('INVOICE_SEQUENCE_EXHAUSTED')
}

export async function nextReceiptNo(): Promise<string> {
  const rows = await db.$queryRaw<Array<{ n: bigint | number }>>`SELECT nextval('payment_receipt_no_seq') AS n`
  const n = Number(rows[0]?.n || 1)
  return `AACT-REC-${new Date().getFullYear()}-${pad(n)}`
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
