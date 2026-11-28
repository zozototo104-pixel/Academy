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
  if (!raw) return 'يرجى إدخال رقم الهوية الشخصية أو الرقم الوطني أو جواز السفر.'

  // المنصة تستقبل طلاباً من دول متعددة، وأرقام الهوية الوطنية تختلف من دولة لأخرى.
  // لذلك لا نفرض 9 أرقام إلا إذا طُلب فحص هوية محلية صارم صراحةً من مسار خاص.
  if (requireStrictNationalId) {
    if (!/^\d{9}$/.test(raw)) return 'رقم الهوية المحلي يجب أن يتكون من 9 أرقام بالضبط.'
    return null
  }

  if (!/^[\p{L}\p{N}-]{5,25}$/u.test(raw)) {
    return 'رقم الهوية/الرقم الوطني/جواز السفر يجب أن يكون بين 5 و25 خانة، ويمكن أن يحتوي أرقاماً أو حروفاً أو شرطة (-).'
  }
  return null
}

export function normalizePhone(value: string) {
  const raw = normalizeDigits(String(value || '').trim())
  const withPlus = raw.startsWith('00') ? `+${raw.slice(2)}` : raw
  return withPlus.replace(/[^+\d]/g, '').replace(/(?!^)\+/g, '')
}

// Shared dial codes for the countries the platform registers (SUPPORTED_COUNTRIES
// in admission-validation.ts, stored as Arabic names). A local number such
// as 0599... is shared by more than one country (Palestine AND Saudi
// Arabia), so the prefix must come from the country on the application —
// never guessed from the number alone. Palestine is 972 here because that
// is how the platform's Palestinian numbers are stored and sent.
const COMPREHENSIVE_INVITE_COUNTRY_DIAL_CODES: Record<string, string> = {
  'فلسطين': '972',
  'الأردن': '962',
  'السعودية': '966',
  'الإمارات': '971',
  'قطر': '974',
  'الكويت': '965',
  'البحرين': '973',
  'عُمان': '968',
  'مصر': '20',
  'العراق': '964',
  'سوريا': '963',
  'لبنان': '961',
  'اليمن': '967',
  'ليبيا': '218',
  'تونس': '216',
  'الجزائر': '213',
  'المغرب': '212',
  'السودان': '249',
  'تركيا': '90',
  'ألمانيا': '49',
  'السويد': '46',
  'الولايات المتحدة': '1',
  'كندا': '1',
  'المملكة المتحدة': '44',
}

// Normalise a phone to the international digits WhatsApp uses as the
// conversation identity (Meta's wa_id). Already-international numbers are
// returned untouched; a local number gets its country's dial code (leading
// 0 dropped); an unknown or missing country leaves the number as-is —
// never guessed, so the archive never lands on the wrong country's thread.
export function normalizePhoneToInternationalWaId(phone: string, country?: string | null): string {
  const normalized = normalizePhone(String(phone || ''))
  const digits = normalized.replace(/\D/g, '')
  if (!digits) return digits
  if (normalized.startsWith('+')) return digits
  const dialCode = COMPREHENSIVE_INVITE_COUNTRY_DIAL_CODES[String(country || '').trim()]
  if (!dialCode) return digits
  if (digits.startsWith(dialCode)) return digits
  return `${dialCode}${digits.startsWith('0') ? digits.slice(1) : digits}`
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
