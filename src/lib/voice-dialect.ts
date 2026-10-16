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

const DIALECT_INSTRUCTION_SUFFIX = 'حافظ على اللهجة طول المكالمة. المصطلحات الأكاديمية خليها بالفصحى أو متل ما هي بالكتاب.'
const DEFAULT_DIALECT_INSTRUCTION = `احكِ بالعربية الفصحى المبسّطة. ${DIALECT_INSTRUCTION_SUFFIX}`

export function dialectInstruction(dialect: unknown): string {
  const code = String(dialect || '').trim()
  const option = VOICE_DIALECT_OPTIONS.find((item) => item.value === code)
  if (!option) return DEFAULT_DIALECT_INSTRUCTION
  return `احكِ باللهجة ${option.dialectName} العامية بشكل طبيعي، ${option.example}. ${DIALECT_INSTRUCTION_SUFFIX}`
}
