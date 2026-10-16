export const VOICE_DIALECT_OPTIONS = [
  { value: 'ar-PS', label: 'شامي/فلسطيني', dialectName: 'الفلسطينية', example: 'متل ما بيحكي معلم فلسطيني مع طالبه' },
  { value: 'ar-JO', label: 'أردني', dialectName: 'الأردنية', example: 'مثل ما بيحكي معلم أردني مع طالبه' },
  { value: 'ar-SY', label: 'سوري', dialectName: 'السورية', example: 'متل ما بيحكي معلم سوري مع طالبه' },
  { value: 'ar-LB', label: 'لبناني', dialectName: 'اللبنانية', example: 'متل ما بيحكي معلم لبناني مع طالبه' },
  { value: 'ar-EG', label: 'مصري', dialectName: 'المصرية', example: 'زي ما بيتكلم معلم مصري مع طالبه' },
  { value: 'ar-SA', label: 'سعودي', dialectName: 'السعودية', example: 'مثل ما يتكلم معلم سعودي مع طالبه' },
  { value: 'ar-IQ', label: 'عراقي', dialectName: 'العراقية', example: 'مثل ما يحچي معلم عراقي ويا طالبه' },
  { value: 'ar-MA', label: 'مغربي', dialectName: 'المغربية', example: 'بحال ما كيهضر أستاذ مغربي مع الطالب ديالو' },
] as const

export type VoiceDialectCode = typeof VOICE_DIALECT_OPTIONS[number]['value']

export const VOICE_DEFAULT_DIALECT: VoiceDialectCode = 'ar-PS'

const VOICE_DIALECT_VALUES = new Set<string>(VOICE_DIALECT_OPTIONS.map((item) => item.value))
const DIALECT_INSTRUCTION_SUFFIX = 'حافظ على اللهجة طول المكالمة. المصطلحات الأكاديمية خليها بالفصحى أو متل ما هي بالكتاب.'

export function isVoiceDialect(code: unknown): code is VoiceDialectCode {
  return VOICE_DIALECT_VALUES.has(String(code || '').trim())
}

export function normalizeVoiceDialect(code: unknown): VoiceDialectCode {
  const clean = String(code || '').trim()
  return isVoiceDialect(clean) ? clean : VOICE_DEFAULT_DIALECT
}

export function dialectInstruction(dialect: unknown): string {
  const code = normalizeVoiceDialect(dialect)
  const option = VOICE_DIALECT_OPTIONS.find((item) => item.value === code)
  if (!option) return `احكِ باللهجة الفلسطينية العامية بشكل طبيعي، متل ما بيحكي معلم فلسطيني مع طالبه. ${DIALECT_INSTRUCTION_SUFFIX}`
  return `احكِ باللهجة ${option.dialectName} العامية بشكل طبيعي، ${option.example}. ${DIALECT_INSTRUCTION_SUFFIX}`
}
