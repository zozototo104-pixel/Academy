const EASTERN_ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

export const SUPPORTED_COUNTRIES = [
  'فلسطين',
  'الأردن',
  'السعودية',
  'الإمارات',
  'قطر',
  'الكويت',
  'البحرين',
  'عُمان',
  'مصر',
  'العراق',
  'سوريا',
  'لبنان',
  'اليمن',
  'ليبيا',
  'تونس',
  'الجزائر',
  'المغرب',
  'السودان',
  'تركيا',
  'ألمانيا',
  'السويد',
  'الولايات المتحدة',
  'كندا',
  'المملكة المتحدة',
  'أخرى',
]

export function normalizeDigits(value: string) {
  return String(value || '').replace(/[٠-٩۰-۹]/g, (d) => {
    const eastern = EASTERN_ARABIC_DIGITS.indexOf(d)
    if (eastern >= 0) return String(eastern)
    const persian = PERSIAN_DIGITS.indexOf(d)
    return persian >= 0 ? String(persian) : d
  })
}

export function applicantNameParts(fullName: string) {
  return String(fullName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((p) => p.trim())
    .filter(Boolean)
}

export function validateApplicantFullName(fullName: string, minParts = 3) {
  const parts = applicantNameParts(fullName)
  if (parts.length < minParts) return `يرجى إدخال الاسم الكامل ${minParts === 4 ? 'الرباعي' : 'الثلاثي'} كما في الوثائق الرسمية.`
  if (parts.some((p) => p.length < 2)) return 'يرجى إدخال الاسم الكامل بدون اختصارات أو أحرف منفردة.'
  return null
}

export function validateNationalIdOrPassport(value: string, country?: string | null, requireStrictNationalId = false) {
  const raw = normalizeDigits(String(value || '').trim()).replace(/\s+/g, '')
  if (!raw) return 'يرجى إدخال رقم الهوية الشخصية أو جواز السفر.'
  const digitsOnly = raw.replace(/\D/g, '')
  const isPalestine = String(country || '').trim() === 'فلسطين'
  if (requireStrictNationalId || isPalestine || /^\d+$/.test(raw)) {
    if (!/^\d{9}$/.test(digitsOnly) || digitsOnly !== raw) return 'رقم الهوية يجب أن يتكون من 9 أرقام بالضبط.'
    return null
  }
  if (!/^[A-Za-z0-9-]{6,20}$/.test(raw)) return 'رقم جواز السفر يجب أن يكون بين 6 و20 خانة من أرقام أو حروف إنجليزية.'
  return null
}

export function normalizePhone(value: string) {
  const raw = normalizeDigits(String(value || '').trim())
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw
  return withPlus.replace(/[^+\d]/g, '').replace(/(?!^)\+/g, '')
}

export function validatePhone(value: string) {
  const phone = normalizePhone(value)
  if (!phone) return 'يرجى إدخال رقم الهاتف.'
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return 'رقم الهاتف يجب أن يحتوي من 8 إلى 15 رقماً مع رمز الدولة عند الإمكان.'
  if (phone.startsWith('+') && !/^\+\d{8,15}$/.test(phone)) return 'صيغة الهاتف الدولية غير صحيحة. مثال: +970598400510'
  if (!phone.startsWith('+') && !/^\d{8,15}$/.test(phone)) return 'صيغة الهاتف غير صحيحة. استخدم الأرقام فقط أو الصيغة الدولية.'
  return null
}

export function calculateAgeYears(birthDate: string | Date, now = new Date()) {
  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate)
  if (Number.isNaN(birth.getTime())) return null
  let age = now.getFullYear() - birth.getFullYear()
  const monthDelta = now.getMonth() - birth.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < birth.getDate())) age -= 1
  return age
}

export function validateBirthDateForMinAge(birthDate: string, minAge: number) {
  if (!birthDate) return `يرجى إدخال تاريخ الميلاد للتحقق من شرط العمر الأدنى (${minAge} سنة).`
  const age = calculateAgeYears(birthDate)
  if (age == null) return 'تاريخ الميلاد غير صحيح.'
  if (age < minAge) return `العمر لا يحقق شرط البرنامج: الحد الأدنى ${minAge} سنة.`
  if (age > 100) return 'يرجى التأكد من تاريخ الميلاد؛ العمر المدخل غير منطقي.'
  return null
}

export function isSupportedCountry(country: string) {
  return SUPPORTED_COUNTRIES.includes(String(country || '').trim())
}
