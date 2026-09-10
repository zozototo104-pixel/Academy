export interface AcademicProgramInput {
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category?: string | null
  hours?: number | null
  unitsCount?: number | null
}

export interface AcademicPlanStage {
  title: string
  description: string
  deliverable: string
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
  graduationRequirements: string[]
  assessmentComponents: string[]
  thesisRequirement: string
  qualityControls: string[]
}

const DEGREE_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني تطبيقي',
  MASTERS: 'ماجستير مهني',
  DOCTORATE: 'دكتوراه مهنية',
  ACCREDITATION: 'اعتماد مهني/استشاري',
  INTL_CERT: 'شهادة دولية مهنية',
}

function cleanSpaces(text: string) {
  return text.replace(/\s+/g, ' ').replace(/[ـ–—]+/g, ' — ').replace(/\s+—\s+/g, ' — ').trim()
}

export function extractProgramSpecialization(titleAr: string, category?: string | null) {
  let title = cleanSpaces(titleAr || '')
  const normalizedCategory = String(category || '').toUpperCase()

  title = title
    .replace(/^برنامج\s+/i, '')
    .replace(/^البرنامج\s+/i, '')
    .replace(/^درجة\s+/i, '')
    .replace(/^الدبلوم\s+(?:المهني\s+)?/i, '')
    .replace(/^دبلوم\s+(?:مهني\s+)?/i, '')
    .replace(/^الماجستير\s+(?:المهني\s+)?(?:في\s+)?/i, '')
    .replace(/^ماجستير\s+(?:مهني\s+)?(?:في\s+)?/i, '')
    .replace(/^الدكتوراه\s+(?:المهنية\s+)?(?:في\s+)?/i, '')
    .replace(/^دكتوراه\s+(?:مهنية\s+)?(?:في\s+)?/i, '')
    .replace(/^اعتماد\s+/i, '')
    .replace(/^شهادة\s+(?:دولية\s+)?(?:في\s+)?/i, '')
    .replace(/^(?:في|بمجال|ضمن)\s+/i, '')
    .trim()

  if (!title && normalizedCategory === 'MASTERS') title = 'التخصص المهني المختار'
  if (!title && normalizedCategory === 'DOCTORATE') title = 'التخصص البحثي المهني المختار'
  if (!title && normalizedCategory === 'DIPLOMA') title = 'المهارة المهنية المختارة'
  if (!title) title = 'المجال المهني المختار'

  return cleanSpaces(title)
}

function focusFor(specialization: string) {
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
      `صياغة حلول وتوصيات تطبيقية مناسبة لسياق المؤسسات والعمل المهني.`,
    ],
    skills: ['التحليل المهني', 'حل المشكلات', 'اتخاذ القرار', 'كتابة التقارير', 'التقييم والتوصية'],
  }
}

function studyPlanFor(category: string, specialization: string): AcademicPlanStage[] {
  if (category === 'DOCTORATE') {
    return [
      { title: 'مرحلة القراءات المتقدمة', description: `دراسة معمقة للنظريات والنماذج المتقدمة في ${specialization}.`, deliverable: 'ملخصات نقدية ومناقشات موجهة.' },
      { title: 'مرحلة التطبيق والتحليل', description: 'تحويل المعرفة إلى أطر تحليلية قابلة للاستخدام في بيئات مهنية واقعية.', deliverable: 'حالات تطبيقية وتقارير تحليل.' },
      { title: 'مرحلة البحث/الأطروحة المهنية', description: 'إعداد بحث تطبيقي يضيف معالجة مهنية لمشكلة واقعية في التخصص.', deliverable: 'بحث نهائي ومناقشة أمام لجنة.' },
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

export function buildAcademicProgramProfile(program: AcademicProgramInput): AcademicProgramProfile {
  const category = String(program.category || '').toUpperCase()
  const degreeLabel = DEGREE_LABEL[category] || 'برنامج مهني'
  const specialization = extractProgramSpecialization(program.titleAr, category)
  const focus = focusFor(specialization)
  const hours = typeof program.hours === 'number' && program.hours > 0 ? `${program.hours} ساعة تدريبية` : 'حسب الخطة المعتمدة للبرنامج'
  const durationLabel = category === 'DOCTORATE'
    ? 'مسار متقدم ينتهي ببحث ومناقشة'
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

  return {
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
    studyPlan: studyPlanFor(category, specialization),
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
}
