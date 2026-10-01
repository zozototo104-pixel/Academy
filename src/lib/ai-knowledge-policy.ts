export type AiKnowledgeScope =
  | 'PUBLIC_VISITOR'
  | 'WHATSAPP_VISITOR'
  | 'STUDENT_SUPERVISOR'
  | 'HUMAN_SUPERVISOR'
  | 'ADMIN_ASSISTANT'
  | 'DEFENSE_EXAMINER'
  | 'EXAM_ASSISTANT'

export type AiKnowledgePolicy = {
  scope: AiKnowledgeScope
  labelAr: string
  canReadPublicCatalog: boolean
  canReadProgramBooks: boolean
  canReadOwnStudentRecord: boolean
  canReadAssignedStudents: boolean
  canReadAdminIndicators: boolean
  canReadFinancialIndicators: boolean
  canReadDefenseContext: boolean
  canReadWhatsAppThread: boolean
  privateDataBoundary: string
  replyGroundingRule: string
}

export const AI_KNOWLEDGE_POLICIES: Record<AiKnowledgeScope, AiKnowledgePolicy> = {
  PUBLIC_VISITOR: {
    scope: 'PUBLIC_VISITOR',
    labelAr: 'زائر الموقع',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: false,
    canReadAssignedStudents: false,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: false,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'معلومات عامة فقط؛ لا يرى بيانات طلاب أو مدفوعات أو سجلات داخلية.',
    replyGroundingRule: 'يرد من كتالوج البرامج النشطة وإعدادات المنصة العامة فقط.',
  },
  WHATSAPP_VISITOR: {
    scope: 'WHATSAPP_VISITOR',
    labelAr: 'زائر واتساب',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: false,
    canReadAssignedStudents: false,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: false,
    canReadWhatsAppThread: true,
    privateDataBoundary: 'معلومات عامة وسياق آخر رسائل واتساب لنفس المحادثة فقط.',
    replyGroundingRule: 'يرد من كتالوج البرامج النشطة وسياق المحادثة، ولا يكشف بيانات داخلية.',
  },
  STUDENT_SUPERVISOR: {
    scope: 'STUDENT_SUPERVISOR',
    labelAr: 'المشرف الذكي للطالب',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: true,
    canReadAssignedStudents: false,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: false,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'يرى ملف الطالب الحالي فقط، ولا يرى طلاباً آخرين أو مؤشرات إدارية.',
    replyGroundingRule: 'يعطي الأولوية لبرنامج الطالب وذاكرته الأكاديمية، ثم كتالوج البرامج العام عند السؤال العام.',
  },
  HUMAN_SUPERVISOR: {
    scope: 'HUMAN_SUPERVISOR',
    labelAr: 'المشرف البشري',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: false,
    canReadAssignedStudents: true,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: false,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'يرى طلابه المعيّنين وفهرس البرامج، ولا يرى كل المنصة أو السجلات المالية العامة.',
    replyGroundingRule: 'يربط إجاباته بطلابه المعيّنين وبالبرامج والكتب المسجلة رسمياً.',
  },
  ADMIN_ASSISTANT: {
    scope: 'ADMIN_ASSISTANT',
    labelAr: 'وكيل الإدارة',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: false,
    canReadAssignedStudents: true,
    canReadAdminIndicators: true,
    canReadFinancialIndicators: true,
    canReadDefenseContext: true,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'أوسع نطاق إداري داخل المنصة، مع الالتزام بعدم اختراع قرارات أو بيانات غير موجودة.',
    replyGroundingRule: 'يقرأ المؤشرات والبرامج والكتب من قاعدة البيانات أولاً، ثم يصيغ جواباً إدارياً واضحاً.',
  },
  DEFENSE_EXAMINER: {
    scope: 'DEFENSE_EXAMINER',
    labelAr: 'مناقش بحث التخرج',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: true,
    canReadAssignedStudents: false,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: true,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'يركز على الطالب والبحث وجلسة المناقشة ولا يعمل كوكيل مبيعات أو قبول.',
    replyGroundingRule: 'يبني الأسئلة والتقييمات على البحث وملف الطالب والسياق الأكاديمي.',
  },
  EXAM_ASSISTANT: {
    scope: 'EXAM_ASSISTANT',
    labelAr: 'وكيل الامتحانات',
    canReadPublicCatalog: true,
    canReadProgramBooks: true,
    canReadOwnStudentRecord: true,
    canReadAssignedStudents: false,
    canReadAdminIndicators: false,
    canReadFinancialIndicators: false,
    canReadDefenseContext: false,
    canReadWhatsAppThread: false,
    privateDataBoundary: 'يركز على امتحان الطالب وكتبه ومخرجات التعلم ولا يكشف إجابات غير مسلّمة.',
    replyGroundingRule: 'يربط التقييم بالكتب والوحدات وبنك المعرفة ومخرجات التعلم.',
  },
}

export function getAiKnowledgePolicy(scope: AiKnowledgeScope): AiKnowledgePolicy {
  return AI_KNOWLEDGE_POLICIES[scope]
}

export function formatAiKnowledgePolicyForPrompt(scope: AiKnowledgeScope): string {
  const policy = getAiKnowledgePolicy(scope)
  return [
    `نطاق معرفة الوكيل: ${policy.labelAr} (${policy.scope}).`,
    `حدود الخصوصية: ${policy.privateDataBoundary}`,
    `قاعدة الاستناد: ${policy.replyGroundingRule}`,
  ].join('\n')
}
