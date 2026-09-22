import type { ServiceFlowKind } from '@/lib/service-flows'

export interface WorkflowPaymentLike {
  status?: string | null
  purpose?: string | null
}

export interface WorkflowDeliverableLike {
  type?: string | null
  status?: string | null
  visibleToStudent?: boolean | null
}

export interface ServiceWorkflowStage {
  id: string
  label: string
  description: string
  deliverableTypes?: string[]
}

export interface ServiceWorkflowDefinition {
  kind: ServiceFlowKind | 'SERVICE_REQUEST'
  title: string
  summary: string
  stages: ServiceWorkflowStage[]
}

export interface ServiceWorkflowState {
  workflow: ServiceWorkflowDefinition
  stages: Array<ServiceWorkflowStage & { state: 'done' | 'active' | 'pending' }>
  activeIndex: number
  activeStage: ServiceWorkflowStage
  nextAction: string
  clientNextAction: string
  expectedDeliverableTypes: string[]
  paid: boolean
  hasInvoice: boolean
  publishedDeliverables: number
}

const GENERIC_SERVICE_WORKFLOW: ServiceWorkflowDefinition = {
  kind: 'SERVICE_REQUEST',
  title: 'مسار تنفيذ خدمة مهنية',
  summary: 'مراجعة الطلب، إصدار فاتورة، تأكيد الدفع، ثم تسليم المخرج المناسب للعميل.',
  stages: [
    { id: 'request', label: 'استلام الطلب', description: 'تثبيت بيانات العميل ومراجعة نوع الخدمة المطلوبة.' },
    { id: 'review', label: 'مراجعة الإدارة', description: 'تحديد النواقص أو السعر أو تفاصيل التنفيذ.' },
    { id: 'payment', label: 'الدفع', description: 'إصدار فاتورة الخدمة وتأكيد السداد الإلكتروني أو المباشر.' },
    { id: 'delivery', label: 'تسليم المخرج', description: 'نشر الملف أو الرابط أو الشهادة في بوابة العميل.', deliverableTypes: ['OTHER'] },
    { id: 'done', label: 'مكتمل', description: 'الخدمة مسلّمة وقابلة للوصول من حساب العميل.' },
  ],
}

export const SERVICE_WORKFLOWS: Partial<Record<ServiceFlowKind, ServiceWorkflowDefinition>> = {
  READY_PACKAGE: {
    kind: 'READY_PACKAGE',
    title: 'مسار الحقيبة التدريبية الجاهزة',
    summary: 'خدمة شراء وتسليم سريعة: دفع ثم رابط/ملف تحميل، بلا مشرف أو شهادة دراسية.',
    stages: [
      { id: 'request', label: 'طلب الحقيبة', description: 'استلام بيانات المشتري واسم/تصنيف الحقيبة المطلوبة.' },
      { id: 'payment', label: 'سداد الرسوم', description: 'تأكيد سداد رسوم الحقيبة أو الدفع المباشر.' },
      { id: 'delivery', label: 'رابط/ملف التحميل', description: 'نشر رابط أو ملف الحقيبة في بوابة العميل.', deliverableTypes: ['PACKAGE_DOWNLOAD'] },
      { id: 'done', label: 'تم التسليم', description: 'الحقيبة متاحة للعميل في تبويب مخرجاتي.' },
    ],
  },
  CUSTOM_PACKAGE: {
    kind: 'CUSTOM_PACKAGE',
    title: 'مسار إعداد حقيبة تدريبية مخصصة',
    summary: 'يجمع المتطلبات، ثم عرض/دفع، ثم مسودة ومراجعة وتسليم نهائي.',
    stages: [
      { id: 'requirements', label: 'جمع المتطلبات', description: 'موضوع الحقيبة، الفئة المستهدفة، الساعات، الهوية البصرية والمراجع.' },
      { id: 'quote-payment', label: 'عرض السعر والدفع', description: 'إصدار عرض/فاتورة الخدمة وتأكيد السداد.' },
      { id: 'draft', label: 'تسليم المسودة', description: 'نشر مسودة أولية للعميل للمراجعة.', deliverableTypes: ['CUSTOM_PACKAGE_DRAFT'] },
      { id: 'revision', label: 'مراجعة العميل', description: 'استقبال الملاحظات وإجراء التعديلات المتفق عليها.' },
      { id: 'final', label: 'التسليم النهائي', description: 'نشر الملفات النهائية Word/PPT/PDF.', deliverableTypes: ['CUSTOM_PACKAGE_FINAL', 'PACKAGE_DOWNLOAD'] },
      { id: 'done', label: 'مكتمل', description: 'تم تسليم النسخة النهائية للعميل.' },
    ],
  },
  EXPERIENCE_EQUIVALENCY: {
    kind: 'EXPERIENCE_EQUIVALENCY',
    title: 'مسار معادلة الخبرة المهنية',
    summary: 'تدقيق السيرة والخبرات ثم قرار اللجنة والدفع وإصدار شهادة أو تقرير معادلة.',
    stages: [
      { id: 'documents', label: 'تدقيق المستندات', description: 'سيرة ذاتية، خبرات، شهادات دورات وأي وثائق داعمة.' },
      { id: 'committee', label: 'تقييم اللجنة', description: 'تحديد الدرجة أو نتيجة المعادلة والنواقص إن وجدت.' },
      { id: 'payment', label: 'سداد الرسوم', description: 'تأكيد فاتورة المعادلة قبل الإصدار.' },
      { id: 'certificate', label: 'إصدار المعادلة', description: 'نشر شهادة أو تقرير معادلة ورابط تحقق.', deliverableTypes: ['EQUIVALENCY_CERTIFICATE', 'CERTIFICATE_PDF'] },
      { id: 'done', label: 'مكتمل', description: 'المعادلة ظاهرة للعميل في مخرجاتي.' },
    ],
  },
  CERTIFICATE_EQUIVALENCY: {
    kind: 'CERTIFICATE_EQUIVALENCY',
    title: 'مسار معادلة الشهادات التدريبية',
    summary: 'تدقيق الشهادات والسيرة ثم اعتماد الوثيقة ورقم التحقق.',
    stages: [
      { id: 'documents', label: 'تدقيق الشهادات', description: 'فحص الشهادات التدريبية والسيرة ووثائق الخبرة.' },
      { id: 'approval', label: 'قرار الاعتماد', description: 'تحديد الدرجة أو العضوية أو نوع الوثيقة المناسبة.' },
      { id: 'payment', label: 'سداد الرسوم', description: 'تأكيد سداد رسوم المعادلة أو الاعتماد.' },
      { id: 'certificate', label: 'إصدار الوثيقة', description: 'نشر شهادة تدريب أو عضوية أو رابط تحقق.', deliverableTypes: ['CERTIFICATE_PDF', 'EQUIVALENCY_CERTIFICATE', 'MEMBERSHIP_CARD'] },
      { id: 'done', label: 'مكتمل', description: 'الوثيقة متاحة للعميل.' },
    ],
  },
  ACCREDITATION_MEMBERSHIP: {
    kind: 'ACCREDITATION_MEMBERSHIP',
    title: 'مسار الاعتماد والعضوية والرخصة',
    summary: 'تدقيق ملف الفرد أو المؤسسة، قرار الاعتماد، الدفع، ثم إصدار الشهادة/البطاقة/الرخصة.',
    stages: [
      { id: 'documents', label: 'تدقيق ملف الاعتماد', description: 'الشهادات، الخبرة، الهوية، بيانات المؤسسة أو المدرب.' },
      { id: 'committee', label: 'قرار الاعتماد', description: 'تحديد نوع الاعتماد أو العضوية أو الرخصة المناسبة.' },
      { id: 'payment', label: 'سداد الاشتراك', description: 'تأكيد السداد السنوي أو الدائم حسب الطلب.' },
      { id: 'issuance', label: 'إصدار الوثائق', description: 'شهادة اعتماد، بطاقة عضوية أو رخصة تدريب.', deliverableTypes: ['ACCREDITATION_CERTIFICATE', 'MEMBERSHIP_CARD', 'CERTIFICATE_PDF'] },
      { id: 'done', label: 'مكتمل', description: 'الاعتماد أو العضوية متاحة للعميل.' },
    ],
  },
  CONSULTING: {
    kind: 'CONSULTING',
    title: 'مسار الاستشارة أو شهادة المستشار',
    summary: 'مراجعة الاحتياج، تحديد موعد أو متطلبات الشهادة، تأكيد الدفع، ثم رابط جلسة/تقرير/شهادة.',
    stages: [
      { id: 'request', label: 'مراجعة الاحتياج', description: 'تحديد مجال الاستشارة أو نوع شهادة المستشار المطلوبة.' },
      { id: 'schedule', label: 'تحديد المستشار/الموعد', description: 'تعيين المستشار وتحديد رابط أو موعد الجلسة عند وجود جلسة.' },
      { id: 'payment', label: 'سداد الرسوم', description: 'تأكيد السداد قبل تنفيذ الجلسة أو إصدار الشهادة.' },
      { id: 'meeting', label: 'رابط الجلسة', description: 'نشر رابط الجلسة أو تعليمات الدخول.', deliverableTypes: ['CONSULTATION_LINK'] },
      { id: 'report', label: 'التقرير أو الشهادة', description: 'نشر تقرير الاستشارة أو شهادة المستشار عند اعتمادها.', deliverableTypes: ['CONSULTATION_REPORT', 'ACCREDITATION_CERTIFICATE', 'CERTIFICATE_PDF'] },
      { id: 'done', label: 'مكتمل', description: 'تم تنفيذ الاستشارة أو إصدار الوثيقة المتفق عليها.' },
    ],
  },
}

export function getServiceWorkflow(kind?: string | null): ServiceWorkflowDefinition {
  if (!kind) return GENERIC_SERVICE_WORKFLOW
  return SERVICE_WORKFLOWS[kind as ServiceFlowKind] || GENERIC_SERVICE_WORKFLOW
}

function hasPublishedDeliverable(deliverables: WorkflowDeliverableLike[], types?: string[]): boolean {
  return deliverables.some((d) => {
    if (d.status !== 'PUBLISHED') return false
    if (d.visibleToStudent === false) return false
    if (!types || !types.length) return true
    return types.includes(String(d.type || ''))
  })
}

function firstPaymentStageIndex(workflow: ServiceWorkflowDefinition): number {
  const idx = workflow.stages.findIndex((s) => /payment|quote-payment/.test(s.id))
  return idx >= 0 ? idx : Math.min(2, workflow.stages.length - 2)
}

function firstDeliveryStageIndex(workflow: ServiceWorkflowDefinition): number {
  const idx = workflow.stages.findIndex((s) => s.deliverableTypes?.length)
  return idx >= 0 ? idx : Math.max(0, workflow.stages.length - 2)
}

export function deriveServiceWorkflowState(input: {
  kind?: string | null
  status?: string | null
  payments?: WorkflowPaymentLike[] | null
  deliverables?: WorkflowDeliverableLike[] | null
}): ServiceWorkflowState {
  const workflow = getServiceWorkflow(input.kind)
  const payments = input.payments || []
  const deliverables = input.deliverables || []
  const hasInvoice = payments.length > 0
  const paid = hasInvoice && payments.every((p) => p.status === 'PAID')
  const paymentIndex = firstPaymentStageIndex(workflow)
  const deliveryIndex = firstDeliveryStageIndex(workflow)
  const publishedDeliverables = deliverables.filter((d) => d.status === 'PUBLISHED' && d.visibleToStudent !== false).length
  const status = String(input.status || 'PENDING')

  let activeIndex = 0
  if (status === 'REJECTED') activeIndex = 0
  else if (status === 'PENDING' || status === 'AWAITING_FEE') activeIndex = 0
  else if (status === 'UNDER_REVIEW') activeIndex = Math.min(1, workflow.stages.length - 1)
  else if (status === 'RESULT_APPROVED' || status === 'CERTIFIED') {
    if (!hasInvoice || !paid) activeIndex = paymentIndex
    else activeIndex = deliveryIndex
  }

  if (paid) {
    const deliveryStage = workflow.stages[deliveryIndex]
    if (deliveryStage && hasPublishedDeliverable(deliverables, deliveryStage.deliverableTypes)) {
      if (workflow.kind === 'CUSTOM_PACKAGE') {
        const hasFinal = hasPublishedDeliverable(deliverables, ['CUSTOM_PACKAGE_FINAL', 'PACKAGE_DOWNLOAD'])
        const hasDraft = hasPublishedDeliverable(deliverables, ['CUSTOM_PACKAGE_DRAFT'])
        activeIndex = hasFinal ? workflow.stages.length - 1 : hasDraft ? Math.min(deliveryIndex + 1, workflow.stages.length - 1) : deliveryIndex
      } else if (workflow.kind === 'CONSULTING') {
        const hasFinal = hasPublishedDeliverable(deliverables, ['CONSULTATION_REPORT', 'ACCREDITATION_CERTIFICATE', 'CERTIFICATE_PDF'])
        const hasMeeting = hasPublishedDeliverable(deliverables, ['CONSULTATION_LINK'])
        activeIndex = hasFinal ? workflow.stages.length - 1 : hasMeeting ? Math.min(deliveryIndex + 1, workflow.stages.length - 1) : deliveryIndex
      } else {
        activeIndex = workflow.stages.length - 1
      }
    }
  }

  activeIndex = Math.max(0, Math.min(activeIndex, workflow.stages.length - 1))
  const activeStage = workflow.stages[activeIndex]
  const expectedDeliverableTypes = activeStage.deliverableTypes || workflow.stages.find((s) => s.deliverableTypes?.length)?.deliverableTypes || ['OTHER']
  const stages = workflow.stages.map((stage, index) => ({
    ...stage,
    state: (index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending') as 'done' | 'active' | 'pending',
  }))

  const nextAction = !hasInvoice
    ? 'أصدر فاتورة الخدمة أولاً ثم اطلب من العميل الدفع الإلكتروني أو الدفع المباشر.'
    : !paid
      ? 'بانتظار تأكيد السداد. بعد الدفع يصبح تسليم المخرج متاحاً.'
      : activeStage.deliverableTypes?.length
        ? 'ارفع أو انشر المخرج المناسب لهذه المرحلة حتى يظهر للعميل.'
        : activeStage.description

  return {
    workflow,
    stages,
    activeIndex,
    activeStage,
    nextAction,
    expectedDeliverableTypes,
    paid,
    hasInvoice,
    publishedDeliverables,
  }
}
