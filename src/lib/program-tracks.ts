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

// ===== الملف الأكاديمي الرسمي للبرنامج =====
export interface AcademicProgramInput {
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category?: string | null
  hours?: number | null
  unitsCount?: number | null
  units?: { title?: string | null; order?: number | null }[]
  books?: { title?: string | null; titleEn?: string | null; semester?: number | null }[]
  exams?: { title?: string | null; semester?: number | null; status?: string | null; questionCount?: number | null }[]
  assignments?: { title?: string | null; semester?: number | null; points?: number | null; status?: string | null }[]
  /** تخصيص إداري اختياري محفوظ داخل admissionRules.academicProfile بدون الحاجة لتعديل قاعدة البيانات. */
  academicProfile?: PartialAcademicProgramProfile | null
}

export interface AcademicPlanStage {
  title: string
  description: string
  deliverable: string
}

export interface AcademicBookRef {
  title: string
  titleEn?: string | null
  semester?: number | null
}

export interface AcademicExamRef {
  title: string
  semester?: number | null
  status?: string | null
  questionCount?: number | null
}

export interface AcademicEvaluationItem {
  label: string
  weight: number
  description: string
}

export interface AcademicTermPlan {
  id: string
  order: number
  title: string
  phase: 'TERM' | 'THESIS' | 'PROJECT' | 'ACCREDITATION'
  weight: number
  description: string
  learningOutcomes: string[]
  requiredSkills: string[]
  requiredBooks: AcademicBookRef[]
  exams: AcademicExamRef[]
  assignments: string[]
  finalEvaluation: string
  statusHint: string
}

export interface AcademicProgramProfile {
  degreeLabel: string
  specialization: string
  academicTitle: string
  levelDescription: string
  creditHoursLabel: string
  durationLabel: string
  learningOutcomes: string[]
  skills: string[]
  studyPlan: AcademicPlanStage[]
  termPlans: AcademicTermPlan[]
  finalEvaluationFormula: AcademicEvaluationItem[]
  graduationRequirements: string[]
  assessmentComponents: string[]
  thesisRequirement: string
  qualityControls: string[]
}

export interface PartialAcademicProgramProfile {
  degreeLabel?: string
  specialization?: string
  academicTitle?: string
  levelDescription?: string
  creditHoursLabel?: string
  durationLabel?: string
  learningOutcomes?: string[]
  skills?: string[]
  studyPlan?: AcademicPlanStage[]
  termPlans?: AcademicTermPlan[]
  finalEvaluationFormula?: AcademicEvaluationItem[]
  graduationRequirements?: string[]
  assessmentComponents?: string[]
  thesisRequirement?: string
  qualityControls?: string[]
}

function cleanList(list: unknown, max = 12): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const rows = list.map((x) => cleanAcademicText(String(x || ''))).filter((x) => x.length > 1)
  return rows.length ? rows.slice(0, max) : undefined
}

function cleanStudyPlan(list: unknown): AcademicPlanStage[] | undefined {
  if (!Array.isArray(list)) return undefined
  const rows = list
    .map((x) => {
      const row = (x && typeof x === 'object') ? (x as Record<string, unknown>) : {}
      return {
        title: cleanAcademicText(String(row.title || '')),
        description: cleanAcademicText(String(row.description || '')),
        deliverable: cleanAcademicText(String(row.deliverable || '')),
      }
    })
    .filter((x) => x.title && x.description)
  return rows.length ? rows.slice(0, 6) : undefined
}

export function normalizeAcademicProfileOverride(raw: unknown): PartialAcademicProgramProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: PartialAcademicProgramProfile = {}
  for (const key of ['degreeLabel', 'specialization', 'academicTitle', 'levelDescription', 'creditHoursLabel', 'durationLabel', 'thesisRequirement'] as const) {
    const value = cleanAcademicText(String(r[key] || ''))
    if (value) out[key] = value
  }
  const learningOutcomes = cleanList(r.learningOutcomes, 12)
  const skills = cleanList(r.skills, 15)
  const graduationRequirements = cleanList(r.graduationRequirements, 12)
  const assessmentComponents = cleanList(r.assessmentComponents, 12)
  const qualityControls = cleanList(r.qualityControls, 12)
  const studyPlan = cleanStudyPlan(r.studyPlan)
  if (learningOutcomes) out.learningOutcomes = learningOutcomes
  if (skills) out.skills = skills
  if (graduationRequirements) out.graduationRequirements = graduationRequirements
  if (assessmentComponents) out.assessmentComponents = assessmentComponents
  if (qualityControls) out.qualityControls = qualityControls
  if (studyPlan) out.studyPlan = studyPlan
  return Object.keys(out).length ? out : null
}

export function academicProfileFromRules(raw: unknown): PartialAcademicProgramProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return normalizeAcademicProfileOverride((raw as Record<string, unknown>).academicProfile)
}

function applyAcademicOverride(base: AcademicProgramProfile, override?: PartialAcademicProgramProfile | null): AcademicProgramProfile {
  const clean = normalizeAcademicProfileOverride(override)
  if (!clean) return base
  return {
    ...base,
    ...clean,
    degreeLabel: clean.degreeLabel || base.degreeLabel,
    specialization: clean.specialization || base.specialization,
    academicTitle: clean.academicTitle || base.academicTitle,
    levelDescription: clean.levelDescription || base.levelDescription,
    creditHoursLabel: clean.creditHoursLabel || base.creditHoursLabel,
    durationLabel: clean.durationLabel || base.durationLabel,
    thesisRequirement: clean.thesisRequirement || base.thesisRequirement,
    learningOutcomes: clean.learningOutcomes?.length ? clean.learningOutcomes : base.learningOutcomes,
    skills: clean.skills?.length ? clean.skills : base.skills,
    studyPlan: clean.studyPlan?.length ? clean.studyPlan : base.studyPlan,
    graduationRequirements: clean.graduationRequirements?.length ? clean.graduationRequirements : base.graduationRequirements,
    assessmentComponents: clean.assessmentComponents?.length ? clean.assessmentComponents : base.assessmentComponents,
    qualityControls: clean.qualityControls?.length ? clean.qualityControls : base.qualityControls,
  }
}

const ACADEMIC_DEGREE_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني تطبيقي',
  MASTERS: 'ماجستير مهني',
  DOCTORATE: 'دكتوراه مهنية',
  ACCREDITATION: 'اعتماد مهني/استشاري',
  INTL_CERT: 'شهادة دولية مهنية',
}

function cleanAcademicText(text: string) {
  return text.replace(/\s+/g, ' ').replace(/[ـ–—]+/g, ' — ').replace(/\s+—\s+/g, ' — ').trim()
}

export function extractProgramSpecialization(titleAr: string, category?: string | null) {
  let title = cleanAcademicText(titleAr || '')
  const normalizedCategory = String(category || '').toUpperCase()

  title = title
    .replace(/^برنامج\s+/iu, '')
    .replace(/^البرنامج\s+/iu, '')
    .replace(/^درجة\s+/iu, '')
    .replace(/^الدبلوم\s+(?:المهني\s+)?/iu, '')
    .replace(/^دبلوم\s+(?:مهني\s+)?/iu, '')
    .replace(/^الماجستير\s+(?:المهني\s+)?(?:في\s+)?/iu, '')
    .replace(/^ماجستير\s+(?:مهني\s+)?(?:في\s+)?/iu, '')
    .replace(/^الدكتوراه\s+(?:المهنية\s+)?(?:في\s+)?/iu, '')
    .replace(/^دكتوراه\s+(?:مهنية\s+)?(?:في\s+)?/iu, '')
    .replace(/^اعتماد\s+/iu, '')
    .replace(/^شهادة\s+(?:دولية\s+)?(?:في\s+)?/iu, '')
    .replace(/^(?:في|بمجال|ضمن)\s+/iu, '')
    .trim()

  if (!title && normalizedCategory === 'MASTERS') title = 'التخصص المهني المختار'
  if (!title && normalizedCategory === 'DOCTORATE') title = 'التخصص البحثي المهني المختار'
  if (!title && normalizedCategory === 'DIPLOMA') title = 'المهارة المهنية المختارة'
  if (!title) title = 'المجال المهني المختار'

  return cleanAcademicText(title)
}

function academicFocusFor(specialization: string) {
  const s = specialization.toLowerCase()
  if (/سيبراني|cyber|security|أمن/.test(s)) {
    return {
      domain: 'الأمن السيبراني',
      outcomes: [
        'تحليل بيئة المخاطر الأمنية وربطها باحتياجات المؤسسة وسياقها التشغيلي.',
        'تقييم الضوابط والسياسات الأمنية وتحديد فجوات الحماية والاستجابة.',
        'بناء توصيات تطبيقية قابلة للقياس لتحسين الحوكمة والامتثال وإدارة الحوادث.',
      ],
      skills: ['تحليل المخاطر', 'حوكمة الأمن السيبراني', 'قراءة مؤشرات الاختراق', 'تصميم ضوابط وقائية', 'كتابة توصيات أمنية مهنية'],
    }
  }
  if (/مشاريع|project|pmp|إدارة المشاريع/.test(s)) {
    return {
      domain: 'إدارة المشاريع',
      outcomes: [
        'تحليل دورة حياة المشروع من المبادرة حتى الإغلاق وربطها بأهداف المؤسسة.',
        'تقييم المخاطر وأصحاب المصلحة والموارد والجودة وفق سياق المشروع.',
        'إعداد توصيات عملية لتحسين التخطيط والجدولة والرقابة على الأداء.',
      ],
      skills: ['تخطيط المشروع', 'تحليل أصحاب المصلحة', 'إدارة المخاطر', 'مؤشرات الأداء', 'إغلاق المشروع والتوثيق'],
    }
  }
  if (/موارد|بشرية|human|hr/.test(s)) {
    return {
      domain: 'إدارة الموارد البشرية',
      outcomes: [
        'تحليل سياسات الموارد البشرية وربطها باستراتيجية المؤسسة وثقافتها.',
        'تقييم ممارسات الاستقطاب والتدريب والأداء والتعويضات بصورة مهنية.',
        'تصميم مبادرات تطوير بشرية قابلة للتطبيق والقياس.',
      ],
      skills: ['تخطيط القوى العاملة', 'إدارة الأداء', 'تصميم التدريب', 'تحليل الوظائف', 'بناء سياسات الموارد البشرية'],
    }
  }
  if (/جودة|quality|iso|تميز/.test(s)) {
    return {
      domain: 'إدارة الجودة والتميز المؤسسي',
      outcomes: [
        'تحليل نظام الجودة وربطه بمتطلبات العملاء والعمليات والمؤشرات.',
        'تقييم فجوات الأداء والامتثال وتحديد فرص التحسين المستمر.',
        'صياغة خطط تحسين قابلة للمتابعة والقياس.',
      ],
      skills: ['تحليل العمليات', 'مؤشرات الجودة', 'إدارة التحسين المستمر', 'التدقيق الداخلي', 'توثيق الإجراءات'],
    }
  }
  if (/تسويق|marketing|مبيعات|sales/.test(s)) {
    return {
      domain: 'التسويق والمبيعات',
      outcomes: [
        'تحليل السوق والعملاء والمنافسين وربط النتائج بقرارات التسويق.',
        'تقييم الحملات والقنوات التسويقية ومؤشرات العائد على الاستثمار.',
        'بناء توصيات عملية لتحسين التموضع والرسائل والتحويلات.',
      ],
      skills: ['تحليل السوق', 'إدارة الحملات', 'قياس ROI', 'بناء الاستراتيجية التسويقية', 'تحسين تجربة العميل'],
    }
  }
  if (/استشاري|استشارات|consult/.test(s)) {
    return {
      domain: 'الاستشارات المهنية',
      outcomes: [
        'تشخيص مشكلة العميل وتحويلها إلى نطاق استشاري واضح ومحدد.',
        'اختيار أدوات التحليل المناسبة وصياغة بدائل وتوصيات قابلة للتنفيذ.',
        'إعداد تقرير استشاري مهني يعرض الأدلة والنتائج وخطة العمل.',
      ],
      skills: ['تشخيص المشكلات', 'تحليل أصحاب المصلحة', 'كتابة التقارير الاستشارية', 'إدارة المقابلات', 'عرض التوصيات'],
    }
  }

  return {
    domain: specialization,
    outcomes: [
      `تحليل المفاهيم الأساسية في ${specialization} وربطها بالممارسة المهنية.`,
      `تقييم الحالات العملية في ${specialization} باستخدام أدوات ومعايير قابلة للقياس.`,
      'صياغة حلول وتوصيات تطبيقية مناسبة لسياق المؤسسات والعمل المهني.',
    ],
    skills: ['التحليل المهني', 'حل المشكلات', 'اتخاذ القرار', 'كتابة التقارير', 'التقييم والتوصية'],
  }
}

function academicStudyPlanFor(category: string, specialization: string): AcademicPlanStage[] {
  if (category === 'DOCTORATE') {
    return [
      { title: 'مرحلة القراءات المتقدمة', description: `دراسة معمقة للنظريات والنماذج المتقدمة في ${specialization}.`, deliverable: 'ملخصات نقدية ومناقشات موجهة.' },
      { title: 'مرحلة التطبيق والتحليل', description: 'تحويل المعرفة إلى أطر تحليلية قابلة للاستخدام في بيئات مهنية واقعية.', deliverable: 'حالات تطبيقية وتقارير تحليل.' },
      { title: 'مرحلة الأطروحة المهنية', description: 'إعداد أطروحة تطبيقية تعالج مشكلة واقعية في التخصص.', deliverable: 'أطروحة نهائية ومناقشة أمام لجنة.' },
    ]
  }
  if (category === 'MASTERS') {
    return [
      { title: 'الفصل الدراسي الأول', description: `تأسيس المفاهيم والمنهجيات الأساسية في ${specialization}.`, deliverable: 'امتحان فصل أول مبني على الكتب المقررة.' },
      { title: 'الفصل الدراسي الثاني', description: 'تطبيق المفاهيم على حالات عملية وتحليل سيناريوهات مهنية.', deliverable: 'امتحان فصل ثانٍ تطبيقي.' },
      { title: 'بحث التخرج المهني', description: 'بحث تطبيقي يربط التخصص بمشكلة واقعية ويعرض نتائج وتوصيات.', deliverable: 'بحث مكتوب ومناقشة فيديو أمام لجنة.' },
    ]
  }
  if (category === 'ACCREDITATION') {
    return [
      { title: 'مراجعة الملف والخبرات', description: 'تحليل السيرة والخبرات والشهادات وربطها بمعايير الاعتماد.', deliverable: 'تقرير أهلية أولي.' },
      { title: 'اختبار أو مقابلة الاعتماد', description: 'قياس الكفاءة المهنية والاستشارية وفق مجال الاعتماد.', deliverable: 'قرار اعتماد أو طلب استكمال.' },
      { title: 'إصدار الاعتماد', description: 'إصدار شهادة اعتماد قابلة للتحقق بعد استيفاء المتطلبات.', deliverable: 'شهادة اعتماد ورقم تحقق.' },
    ]
  }
  return [
    { title: 'مرحلة التأسيس', description: `تعلم المفاهيم والمهارات الأساسية في ${specialization}.`, deliverable: 'أنشطة وقراءات موجهة.' },
    { title: 'مرحلة التطبيق', description: 'تطبيق المعرفة على حالات عملية وتمارين مهنية.', deliverable: 'اختبار تطبيقي أو مشروع قصير.' },
    { title: 'مرحلة الإتقان', description: 'قياس القدرة على استخدام المهارة في سياق العمل.', deliverable: 'تقييم نهائي وشهادة دبلوم.' },
  ]
}

function booksForSemester(program: AcademicProgramInput, semester: number): AcademicBookRef[] {
  const all = (program.books || []).filter((b) => b?.title)
  const specific = all.filter((b) => Number(b.semester || 0) === semester)
  const general = all.filter((b) => !b.semester)
  const chosen = specific.length ? specific : general
  return chosen.slice(0, 8).map((b) => ({ title: String(b.title || '').trim(), titleEn: b.titleEn || null, semester: b.semester || semester }))
}

function examsForSemester(program: AcademicProgramInput, semester: number): AcademicExamRef[] {
  return (program.exams || [])
    .filter((e) => Number(e.semester || 1) === semester)
    .slice(0, 4)
    .map((e) => ({ title: String(e.title || '').trim(), semester, status: e.status || null, questionCount: e.questionCount || null }))
}

function assignmentLabelsForSemester(program: AcademicProgramInput, semester: number): string[] {
  return (program.assignments || [])
    .filter((a) => Number(a.semester || 1) === semester && a.status !== 'ARCHIVED' && a.title)
    .slice(0, 5)
    .map((a) => {
      const pts = Number(a.points || 0)
      return `${String(a.title || '').trim()}${pts > 0 ? ` (${pts} نقاط)` : ''}`
    })
}

function unitsForStage(program: AcademicProgramInput, index: number) {
  const units = [...(program.units || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).filter((u) => u.title)
  if (units.length === 0) return []
  const midpoint = Math.ceil(units.length / 2)
  return (index === 1 ? units.slice(0, midpoint) : units.slice(midpoint)).map((u) => String(u.title || '').trim()).slice(0, 6)
}

function finalEvaluationFormulaFor(category: string): AcademicEvaluationItem[] {
  if (category === 'DOCTORATE') {
    return [
      { label: 'القراءات المتقدمة', weight: 20, description: 'اختبارات أو تقارير نقدية مبنية على المراجع المقررة.' },
      { label: 'التطبيق والتحليل', weight: 20, description: 'حالات عملية وأدوات تحليل مرتبطة بسياق التخصص.' },
      { label: 'الأطروحة المهنية', weight: 40, description: 'بحث تطبيقي معمق يعالج مشكلة مهنية واقعية.' },
      { label: 'المناقشة النهائية', weight: 20, description: 'مناقشة فيديو أمام اللجنة مع محضر وتقييم نهائي.' },
    ]
  }
  if (category === 'MASTERS') {
    return [
      { label: 'امتحان الفصل الأول', weight: 25, description: 'قياس المفاهيم الأساسية والقراءات الأولى.' },
      { label: 'امتحان الفصل الثاني', weight: 25, description: 'قياس التطبيق والتحليل والحالات العملية.' },
      { label: 'بحث التخرج المهني', weight: 30, description: 'بحث تطبيقي يوثق المشكلة والمنهجية والنتائج.' },
      { label: 'المناقشة النهائية', weight: 20, description: 'مناقشة صوتية/مرئية مع اللجنة والمستشار الذكي.' },
    ]
  }
  if (category === 'ACCREDITATION') {
    return [
      { label: 'ملف الخبرات والوثائق', weight: 40, description: 'مطابقة الوثائق والخبرات مع متطلبات الاعتماد.' },
      { label: 'تقييم الكفاءة أو المقابلة', weight: 40, description: 'قياس القدرة المهنية والاستشارية في مجال الاعتماد.' },
      { label: 'قرار اللجنة', weight: 20, description: 'اعتماد نهائي أو طلب استكمال وفق ضوابط الإدارة.' },
    ]
  }
  return [
    { label: 'الأنشطة والقراءات', weight: 25, description: 'متابعة المحتوى والكتب أو المواد المقررة.' },
    { label: 'الواجبات التطبيقية', weight: 25, description: 'تكليفات قصيرة وحالات عملية مرتبطة بالمهارة.' },
    { label: 'الاختبار النهائي', weight: 50, description: 'قياس إتقان المهارة ومخرجات البرنامج.' },
  ]
}

function buildDetailedTermPlans(program: AcademicProgramInput, category: string, specialization: string, focus: ReturnType<typeof academicFocusFor>): AcademicTermPlan[] {
  const term1Books = booksForSemester(program, 1)
  const term2Books = booksForSemester(program, 2)
  const term1Exams = examsForSemester(program, 1)
  const term2Exams = examsForSemester(program, 2)
  const term1Assignments = assignmentLabelsForSemester(program, 1)
  const term2Assignments = assignmentLabelsForSemester(program, 2)
  const unitStage1 = unitsForStage(program, 1)
  const unitStage2 = unitsForStage(program, 2)

  if (category === 'ACCREDITATION') {
    return [
      {
        id: 'portfolio-review', order: 1, title: 'مرحلة ملف الاعتماد', phase: 'ACCREDITATION', weight: 40,
        description: `تدقيق السيرة والخبرات والشهادات وربطها بمعايير الاعتماد في ${specialization}.`,
        learningOutcomes: ['إثبات الأهلية المهنية بالوثائق والخبرات.', 'تحديد فجوات الملف قبل قرار الاعتماد.'],
        requiredSkills: ['توثيق الخبرة', 'عرض الإنجازات', 'قراءة معايير الاعتماد'],
        requiredBooks: term1Books,
        exams: term1Exams,
        assignments: ['رفع السيرة والشهادات والخبرات الداعمة.', 'تقديم ملخص مهني يوضح نطاق الخبرة ومجالات الممارسة.'],
        finalEvaluation: 'تقرير أهلية ذكي ومراجعة بشرية قبل الانتقال للتقييم النهائي.',
        statusHint: 'لا يبدأ الاعتماد النهائي قبل اكتمال الوثائق المطلوبة.',
      },
      {
        id: 'competency-assessment', order: 2, title: 'تقييم الكفاءة المهنية', phase: 'ACCREDITATION', weight: 40,
        description: 'اختبار أو مقابلة للتحقق من قدرة المتقدم على ممارسة الدور الاستشاري أو المهني.',
        learningOutcomes: ['إثبات الفهم العملي للمجال.', 'الدفاع عن الخبرة والتوصيات بمهنية.'],
        requiredSkills: ['المقابلة المهنية', 'تحليل الحالة', 'صياغة التوصيات'],
        requiredBooks: term2Books,
        exams: term2Exams,
        assignments: ['تحليل حالة مهنية قصيرة في مجال الاعتماد.'],
        finalEvaluation: 'نتيجة تقييم الكفاءة أو المقابلة مع توصية اعتماد/استكمال.',
        statusHint: 'تُراجع النتيجة قبل إصدار شهادة الاعتماد.',
      },
    ]
  }

  if (category === 'MASTERS' || category === 'DOCTORATE') {
    const researchLabel = category === 'DOCTORATE' ? 'الأطروحة المهنية' : 'بحث التخرج المهني'
    return [
      {
        id: 'term-1', order: 1, title: category === 'DOCTORATE' ? 'مرحلة القراءات المتقدمة' : 'الفصل الدراسي الأول', phase: 'TERM', weight: category === 'DOCTORATE' ? 20 : 25,
        description: `تأسيس المعرفة والمنهجيات الرئيسية في ${specialization} من خلال الكتب والوحدات الأولى.`,
        learningOutcomes: focus.outcomes.slice(0, 2),
        requiredSkills: focus.skills.slice(0, 4),
        requiredBooks: term1Books,
        exams: term1Exams,
        assignments: [
          'تلخيص تحليلي لأهم مفاهيم الكتب المقررة.',
          ...(unitStage1.length ? [`تطبيق مفاهيم: ${unitStage1.join('، ')}.`] : ['تطبيق المفاهيم على حالة عملية قصيرة.']),
        ],
        finalEvaluation: 'امتحان فصل أول أو تقرير نقدي يقيس الفهم والتحليل.',
        statusHint: 'يُنصح باجتياز هذه المرحلة قبل الانتقال للتطبيقات المتقدمة.',
      },
      {
        id: 'term-2', order: 2, title: category === 'DOCTORATE' ? 'مرحلة التطبيق والتحليل' : 'الفصل الدراسي الثاني', phase: 'TERM', weight: category === 'DOCTORATE' ? 20 : 25,
        description: 'تحويل المفاهيم إلى حالات تطبيقية، مع قياس القدرة على التحليل والتقييم واتخاذ القرار.',
        learningOutcomes: focus.outcomes.slice(1, 3).concat('بناء توصيات مهنية قابلة للتطبيق والقياس.'),
        requiredSkills: focus.skills.slice(2, 6).concat('تحليل الحالات'),
        requiredBooks: term2Books,
        exams: term2Exams,
        assignments: [
          'دراسة حالة تطبيقية مرتبطة بالتخصص.',
          ...(unitStage2.length ? [`ربط الوحدات المتقدمة: ${unitStage2.join('، ')} بالواقع المهني.`] : ['إعداد تقرير توصيات تطبيقي قصير.']),
        ],
        finalEvaluation: 'امتحان فصل ثانٍ تطبيقي أو ملف تحليل حالة.',
        statusHint: 'يفتح هذا الفصل بعد استكمال متطلبات الفصل الأول وفق سياسة البرنامج.',
      },
      {
        id: 'research', order: 3, title: researchLabel, phase: 'THESIS', weight: category === 'DOCTORATE' ? 40 : 30,
        description: `إعداد ${researchLabel} يربط ${specialization} بمشكلة مهنية حقيقية وينتهي بتوصيات قابلة للتنفيذ.`,
        learningOutcomes: ['صياغة مشكلة بحثية مهنية واضحة.', 'اختيار منهجية مناسبة وتحليل النتائج.', 'الدفاع عن التوصيات أمام لجنة المناقشة.'],
        requiredSkills: ['كتابة البحث', 'تحليل البيانات أو الحالات', 'العرض والدفاع', 'الاستدلال بالأدلة'],
        requiredBooks: [],
        exams: [],
        assignments: ['تقديم مقترح بحث.', 'رفع نسخة البحث النهائية.', 'إجراء مناقشة فيديو مسجلة بمحضر.'],
        finalEvaluation: 'تقييم البحث والمناقشة مع اعتماد اللجنة البشرية ودعم المستشار الذكي.',
        statusHint: 'لا تصدر الشهادة قبل اعتماد البحث والمناقشة عند البرامج التي تتطلب ذلك.',
      },
    ]
  }

  return [
    {
      id: 'foundation', order: 1, title: 'مرحلة التأسيس', phase: 'TERM', weight: 25,
      description: `فهم مبادئ ${specialization} والمصطلحات والأدوات الأساسية.`,
      learningOutcomes: focus.outcomes.slice(0, 2),
      requiredSkills: focus.skills.slice(0, 4),
      requiredBooks: term1Books,
      exams: term1Exams,
      assignments: ['قراءات موجهة وتلخيص أهم المفاهيم.', 'نشاط قصير للتحقق من الفهم.'],
      finalEvaluation: 'اختبار قصير أو نشاط تطبيقي أولي.',
      statusHint: 'مرحلة تمهيدية لبناء أساس المهارة.',
    },
    {
      id: 'application', order: 2, title: 'مرحلة التطبيق', phase: 'TERM', weight: 35,
      description: 'تطبيق المفاهيم على سيناريوهات عملية وحالات قريبة من بيئة العمل.',
      learningOutcomes: focus.outcomes.slice(1, 3),
      requiredSkills: focus.skills.slice(2, 6),
      requiredBooks: term2Books,
      exams: term2Exams,
      assignments: ['تحليل حالة مهنية قصيرة.', 'تقديم مخرج تطبيقي قابل للمراجعة.'],
      finalEvaluation: 'تقييم تطبيقي يقيس القدرة على الاستخدام العملي.',
      statusHint: 'يُنصح بإتمام القراءات قبل الاختبار التطبيقي.',
    },
    {
      id: 'final-project', order: 3, title: 'المشروع أو التقييم النهائي', phase: 'PROJECT', weight: 40,
      description: 'قياس إتقان المهارة من خلال اختبار نهائي أو مشروع تطبيقي مختصر.',
      learningOutcomes: ['إثبات القدرة على تطبيق المهارة في سياق مهني.', 'تقديم نتيجة قابلة للتقييم والاعتماد.'],
      requiredSkills: ['التطبيق العملي', 'التوثيق', 'العرض المختصر'],
      requiredBooks: [],
      exams: [],
      assignments: ['تسليم مشروع تطبيقي أو اجتياز الاختبار النهائي.'],
      finalEvaluation: 'اعتماد نهائي للمهارة وإصدار الشهادة عند استيفاء المتطلبات.',
      statusHint: 'تغلق المرحلة بعد اعتماد الإدارة للنتيجة النهائية.',
    },
  ]
}

export function buildAcademicProgramProfile(program: AcademicProgramInput): AcademicProgramProfile {
  const category = String(program.category || '').toUpperCase()
  const degreeLabel = ACADEMIC_DEGREE_LABEL[category] || 'برنامج مهني'
  const specialization = extractProgramSpecialization(program.titleAr, category)
  const focus = academicFocusFor(specialization)
  const hours = typeof program.hours === 'number' && program.hours > 0 ? `${program.hours} ساعة تدريبية` : 'حسب الخطة المعتمدة للبرنامج'
  const durationLabel = category === 'DOCTORATE'
    ? 'مسار متقدم ينتهي بأطروحة ومناقشة'
    : category === 'MASTERS'
      ? 'فصلان دراسيان + بحث تخرج مهني'
      : category === 'ACCREDITATION'
        ? 'مراجعة أهلية + تقييم اعتماد'
        : 'مسار تدريبي تطبيقي مرن'

  const thesisRequirement = category === 'MASTERS' || category === 'DOCTORATE'
    ? `يتطلب البرنامج بحث تخرج/أطروحة مهنية في ${specialization}، ثم مناقشة عبر الفيديو أمام لجنة تضم مشرفاً بشرياً والمستشار الذكي كمحلل مساعد.`
    : category === 'ACCREDITATION'
      ? 'يركز المسار على توثيق الخبرة المهنية وقياس أهلية الاعتماد، ولا يتطلب بحث تخرج إلا إذا نصت قواعد الاعتماد على ذلك.'
      : 'قد يتضمن البرنامج مشروعاً تطبيقياً أو حالة عملية بدلاً من بحث تخرج كامل، حسب طبيعة الدبلوم.'
  const termPlans = buildDetailedTermPlans(program, category, specialization, focus)
  const finalEvaluationFormula = finalEvaluationFormulaFor(category)

  const base: AcademicProgramProfile = {
    degreeLabel,
    specialization,
    academicTitle: `${degreeLabel} في ${specialization}`,
    levelDescription: `ملف أكاديمي مهني يوضح هدف البرنامج، مخرجات التعلم، خطة الدراسة، ومعايير التخرج في مجال ${focus.domain}.`,
    creditHoursLabel: hours,
    durationLabel,
    learningOutcomes: [
      ...focus.outcomes,
      'ربط المعرفة النظرية بالقرارات المهنية والحالات الواقعية.',
      'إعداد عرض أو تقرير نهائي يوضح المشكلة والتحليل والتوصيات.',
    ],
    skills: Array.from(new Set([...focus.skills, 'التفكير النقدي', 'التواصل المهني', 'العرض والمناقشة'])).slice(0, 9),
    studyPlan: academicStudyPlanFor(category, specialization),
    termPlans,
    finalEvaluationFormula,
    graduationRequirements: category === 'ACCREDITATION'
      ? [
          'تقديم ملف خبرات ووثائق داعمة واضحة وقابلة للتحقق.',
          'اجتياز مراجعة الأهلية وفق قواعد الاعتماد المحددة للبرنامج.',
          'اجتياز مقابلة أو تقييم مهني إذا تطلب المسار ذلك.',
          'اعتماد القرار النهائي من الإدارة/اللجنة المختصة.',
        ]
      : [
          'الالتزام بالكتب والمراجع المقررة داخل البرنامج.',
          'اجتياز امتحانات الفصول أو الوحدات وفق حد النجاح المعتمد.',
          'استكمال الأنشطة أو المشاريع التطبيقية المطلوبة.',
          ...(category === 'MASTERS' || category === 'DOCTORATE' ? ['تسليم بحث تخرج مهني قابل للمناقشة.', 'اجتياز مناقشة البحث أمام اللجنة.'] : []),
          'صدور قرار الإكمال واعتماد السجل الأكاديمي قبل إصدار الشهادة.',
        ],
    assessmentComponents: category === 'ACCREDITATION'
      ? [
          'تحليل ملف الخبرات والوثائق.',
          'مطابقة المتطلبات بالقواعد المعتمدة.',
          'مقابلة أو تقييم كفاءة عند الحاجة.',
          'قرار اعتماد نهائي من الإدارة.',
        ]
      : [
          'امتحانات مبنية على الكتب المقررة ومحتوى التخصص.',
          'أسئلة متنوعة: اختيار، صح وخطأ، إجابة قصيرة، وحالات تطبيقية.',
          'تحليل ذكي للأداء مع مراجعة واعتماد بشري عند الحاجة.',
          ...(category === 'MASTERS' || category === 'DOCTORATE' ? ['بحث تخرج ومناقشة فيديو مدعومة بالمستشار الذكي.'] : ['تقييم تطبيقي نهائي حسب البرنامج.']),
        ],
    thesisRequirement,
    qualityControls: [
      'ربط الأسئلة بمحتوى الكتب والمراجع المعتمدة لا بمجرد المعرفة العامة.',
      'توثيق التقدم والدرجات داخل السجل الأكاديمي للطالب.',
      'إتاحة التحقق من الشهادة برقم وQR بعد الاعتماد النهائي.',
      'إبقاء القرار الأكاديمي النهائي بيد الإدارة أو اللجنة البشرية، مع دعم تحليلي من الذكاء الاصطناعي.',
    ],
  }

  return applyAcademicOverride(base, program.academicProfile)
}
