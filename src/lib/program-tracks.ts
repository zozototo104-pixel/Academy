// ===== مسارات الدرجات والتخصصات =====
// الماجستير والدكتوراه ليسا تخصصاً واحداً باسم «كافة التخصصات».
// نولّد برنامجاً مستقلاً لكل تخصص حتى تكون الكتب والاختبارات والقبول مرتبطة بالتخصص الصحيح.

type DegreeCategory = 'MASTERS' | 'DOCTORATE'

type SeedLike = {
  slug: string
  titleAr: string
  titleEn?: string
  description: string
  category: string
  hours?: number
  price?: number
  icon: string
  features: string[]
  order: number
  units: any[]
}

export const GENERIC_ALL_SPECIALIZATIONS_SLUGS = ['professional-masters', 'professional-doctorate']

export const PROGRAM_CATEGORY_ORDER = ['MASTERS', 'DOCTORATE', 'DIPLOMA', 'INTL_CERT', 'ACCREDITATION']

export const PROGRAM_CATEGORY_AR: Record<string, string> = {
  MASTERS: 'الماجستير المهني',
  DOCTORATE: 'الدكتوراه المهنية',
  DIPLOMA: 'الدبلومات المهنية',
  INTL_CERT: 'الشهادات الدولية',
  ACCREDITATION: 'الاعتمادات المهنية',
}

export interface DegreeSpecialization {
  slug: string
  titleAr: string
  titleEn: string
  icon?: string
}

export const DEGREE_SPECIALIZATIONS: DegreeSpecialization[] = [
  { slug: 'business-administration', titleAr: 'إدارة الأعمال', titleEn: 'Business Administration', icon: 'briefcase' },
  { slug: 'strategic-management', titleAr: 'الإدارة الاستراتيجية', titleEn: 'Strategic Management', icon: 'compass' },
  { slug: 'human-resources', titleAr: 'إدارة الموارد البشرية', titleEn: 'Human Resource Management', icon: 'users' },
  { slug: 'project-management', titleAr: 'إدارة المشاريع', titleEn: 'Project Management', icon: 'briefcase' },
  { slug: 'marketing-management', titleAr: 'إدارة التسويق', titleEn: 'Marketing Management', icon: 'megaphone' },
  { slug: 'accounting-finance', titleAr: 'المحاسبة والمالية', titleEn: 'Accounting and Finance', icon: 'calculator' },
  { slug: 'public-administration', titleAr: 'الإدارة العامة', titleEn: 'Public Administration', icon: 'building-2' },
  { slug: 'healthcare-management', titleAr: 'الإدارة الصحية وإدارة المستشفيات', titleEn: 'Healthcare and Hospital Management', icon: 'heart-pulse' },
  { slug: 'quality-management', titleAr: 'إدارة الجودة الشاملة', titleEn: 'Total Quality Management', icon: 'badge-check' },
  { slug: 'occupational-safety', titleAr: 'السلامة والصحة المهنية', titleEn: 'Occupational Health and Safety', icon: 'hard-hat' },
  { slug: 'leadership-management', titleAr: 'القيادة الإدارية', titleEn: 'Leadership and Management', icon: 'award' },
  { slug: 'training-development', titleAr: 'التدريب وتطوير الأداء', titleEn: 'Training and Performance Development', icon: 'presentation' },
  { slug: 'management-information-systems', titleAr: 'نظم المعلومات الإدارية', titleEn: 'Management Information Systems', icon: 'monitor' },
  { slug: 'artificial-intelligence', titleAr: 'الذكاء الاصطناعي والتحول الرقمي', titleEn: 'Artificial Intelligence and Digital Transformation', icon: 'bot' },
  { slug: 'business-analytics', titleAr: 'تحليل البيانات وذكاء الأعمال', titleEn: 'Business Analytics and Data Analysis', icon: 'gauge' },
  { slug: 'cybersecurity', titleAr: 'الأمن السيبراني', titleEn: 'Cybersecurity', icon: 'shield-check' },
  { slug: 'education-management', titleAr: 'الإدارة التعليمية', titleEn: 'Educational Management', icon: 'school' },
  { slug: 'kindergarten-management', titleAr: 'إدارة رياض الأطفال والطفولة المبكرة', titleEn: 'Kindergarten and Early Childhood Management', icon: 'school' },
  { slug: 'guidance-counseling', titleAr: 'التوجيه والإرشاد', titleEn: 'Guidance and Counseling', icon: 'compass' },
  { slug: 'learning-disabilities', titleAr: 'صعوبات التعلم', titleEn: 'Learning Disabilities', icon: 'book-open' },
  { slug: 'learning-resources', titleAr: 'إدارة مصادر التعلم', titleEn: 'Learning Resource Management', icon: 'library' },
  { slug: 'journalism-media', titleAr: 'الإعلام والمهارات الصحفية', titleEn: 'Media and Journalism Skills', icon: 'newspaper' },
  { slug: 'public-relations-customer-service', titleAr: 'العلاقات العامة وخدمة العملاء', titleEn: 'Public Relations and Customer Service', icon: 'headphones' },
  { slug: 'tourism-management', titleAr: 'الإدارة السياحية والفندقية', titleEn: 'Tourism and Hospitality Management', icon: 'plane' },
  { slug: 'office-management', titleAr: 'السكرتارية وإدارة المكاتب', titleEn: 'Secretarial Studies and Office Management', icon: 'clipboard' },
  { slug: 'insurance-management', titleAr: 'التأمين وإدارة المخاطر', titleEn: 'Insurance and Risk Management', icon: 'shield-check' },
  { slug: 'logistics-supply-chain', titleAr: 'اللوجستيات وسلاسل الإمداد', titleEn: 'Logistics and Supply Chain Management', icon: 'shopping-cart' },
  { slug: 'procurement-contracts', titleAr: 'المشتريات والعقود', titleEn: 'Procurement and Contracts Management', icon: 'shopping-cart' },
  { slug: 'governance-risk-compliance', titleAr: 'الحوكمة وإدارة المخاطر والامتثال', titleEn: 'Governance, Risk and Compliance', icon: 'shield-check' },
  { slug: 'crisis-disaster-management', titleAr: 'إدارة الأزمات والكوارث', titleEn: 'Crisis and Disaster Management', icon: 'shield-alert' },
  { slug: 'diplomacy-international-relations', titleAr: 'الدبلوماسية والعلاقات الدولية', titleEn: 'Diplomacy and International Relations', icon: 'globe' },
  { slug: 'entrepreneurship', titleAr: 'ريادة الأعمال', titleEn: 'Entrepreneurship', icon: 'trending-up' },
]

export function isGenericAllSpecializationsProgram(p: { slug?: string | null; titleAr?: string | null }): boolean {
  const slug = String(p.slug || '')
  const title = String(p.titleAr || '')
  return GENERIC_ALL_SPECIALIZATIONS_SLUGS.includes(slug) || /كافة التخصصات|كل التخصصات/i.test(title)
}

export function degreePrefix(category: string): string {
  if (category === 'DOCTORATE') return 'الدكتوراه المهنية'
  if (category === 'MASTERS') return 'الماجستير المهني'
  return PROGRAM_CATEGORY_AR[category] || category
}

export function degreePrice(category: string): number | undefined {
  if (category === 'DOCTORATE') return 1300
  if (category === 'MASTERS') return 700
  return undefined
}

export function degreeSlugPrefix(category: DegreeCategory): string {
  return category === 'DOCTORATE' ? 'professional-doctorate' : 'professional-masters'
}

export function buildDegreeProgramTitle(category: DegreeCategory, specializationAr: string): string {
  return `${degreePrefix(category)} في ${specializationAr}`
}

export function buildDegreeProgramTitleEn(category: DegreeCategory, specializationEn: string): string {
  return `${category === 'DOCTORATE' ? 'Professional Doctorate' : 'Professional Master'} in ${specializationEn}`
}

export function programSpecialtyLabel(program: { titleAr: string; category: string }): string {
  const title = String(program.titleAr || '')
  if (program.category === 'MASTERS') return title.replace(/^الماجستير\s+المهني\s+في\s+/u, '').trim()
  if (program.category === 'DOCTORATE') return title.replace(/^الدكتوراه\s+المهنية\s+في\s+/u, '').trim()
  return title
}

function buildDescription(category: DegreeCategory, spec: DegreeSpecialization): string {
  const level = degreePrefix(category)
  return `${level} في ${spec.titleAr}: برنامج مهني متخصص ضمن برامج الأكاديمية الأمريكية للاستشارات والتدريب للعام 2026-2027. يركز على المعرفة التطبيقية والبحث المهني ودراسة الحالات العملية في تخصص ${spec.titleAr}. البرنامج في مجال التدريب المهني فقط وليس له علاقة بالمتطلبات الأكاديمية الحكومية، ولا يشمل تخصص الطب البشري.`
}

function features(category: DegreeCategory, spec: DegreeSpecialization): string[] {
  const level = degreePrefix(category)
  return [
    `${level} متخصص في ${spec.titleAr} وليس برنامجاً عاماً لكل التخصصات`,
    'متاح ضمن كافة التخصصات المهنية باستثناء الطب البشري',
    'كتب واختبارات ومناقشات مرتبطة بالتخصص المختار تحديداً',
    category === 'DOCTORATE' ? 'بحث تطبيقي ولجنة مناقشة للدكتوراه المهنية' : 'منهجية مرنة تناسب المهنيين العاملين',
  ]
}

export function degreeSpecializationSeedPrograms(): SeedLike[] {
  const rows: SeedLike[] = []
  for (const category of ['MASTERS', 'DOCTORATE'] as DegreeCategory[]) {
    const baseOrder = category === 'MASTERS' ? 1000 : 2000
    for (let i = 0; i < DEGREE_SPECIALIZATIONS.length; i++) {
      const spec = DEGREE_SPECIALIZATIONS[i]
      rows.push({
        slug: `${degreeSlugPrefix(category)}-${spec.slug}`,
        titleAr: buildDegreeProgramTitle(category, spec.titleAr),
        titleEn: buildDegreeProgramTitleEn(category, spec.titleEn),
        description: buildDescription(category, spec),
        category,
        price: degreePrice(category),
        icon: spec.icon || (category === 'DOCTORATE' ? 'award' : 'book-open'),
        features: features(category, spec),
        order: baseOrder + i,
        units: [],
      })
    }
  }
  return rows
}
