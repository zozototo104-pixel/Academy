// حارس اكتمال الطالب التشخيصي وميزانية فحص الجودة الموحدة (بوابة #706):
// طلب المجس كان ينفّذ مراحل متسلسلة بلا مهلة كلية، فتجاوز مجموعها مهلة
// العميل (80 ثانية) رغم أن استدعاء الذكاء وحده مسقوف بـ48 ثانية. الإصلاح:
// قراءة الطالب الثابت أولاً ولا يُوثق به إلا مكتمل العلاقات التي تستهلكها
// المجسات؛ ميزانية 70 ثانية من بداية الطلب تمرَّر deadlineMs إلى الوكيل؛
// واستنفادها في أي مرحلة يرجع فشلاً صريحاً يسمّي المرحلة (passed=false
// وskipped=false) لا نجاحاً وهمياً ولا تخطياً ولا خطأ HTTP عاماً. هذا
// الاختبار يثبت الدوال النقية سلوكياً، ويثبت نصياً توصيلات المسار التي
// لا يمكن تشغيلها محلياً (المسار يحتاج قاعدة وخدمات ذكاء حية).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  LAUNCH_QUALITY_EMAIL,
  LAUNCH_QUALITY_PROGRAM_SLUG,
  LAUNCH_QUALITY_REFERENCE,
  LAUNCH_QUALITY_REQUEST_BUDGET_MS,
  diagnosticStudentIsComplete,
  isLaunchQualityDeadlineError,
  launchQualityDeadlineError,
  remainingLaunchQualityBudget,
} from '@/lib/launch-quality-diagnostic'

const routeSource = readFileSync('src/app/api/admin/launch-quality/route.ts', 'utf8')
const specSource = readFileSync('tests/e2e/launch-quality.spec.ts', 'utf8')

// مرآة دقيقة لما تكتبه سلسلة التجهيز ensureLaunchQualityDiagnosticStudent
// (مُتحقق منها سطراً سطراً): أي حقل هنا تتطلبه الدالة ولا تكتبه السلسلة
// يجعل القراءة الأولى مستحيلة، وأي حقل تكتبه السلسلة ولا تتطلبه الدالة
// يجعل القراءة تثق ببيانات ناقصة.
function completeStudent(): any {
  return {
    role: 'STUDENT',
    email: 'launch.quality.student@aact.test',
    name: 'طالب فحص جاهزية الإطلاق',
    enrollments: [{
      status: 'ACTIVE',
      program: {
        slug: 'launch-quality-diagnostic-program',
        units: [{ title: 'الوحدة الأولى' }, { title: 'الوحدة الثانية' }],
        books: [{ title: 'دليل الحوكمة وإدارة المخاطر المؤسسية' }],
        studyGuides: [{ title: 'الدليل الدراسي العام' }],
      },
    }],
    ownedAdmissions: [{ reference: 'AACT-LAUNCH-QUALITY' }],
    theses: [{ title: 'أثر مؤشرات المخاطر الرئيسية على فعالية الحوكمة المؤسسية', status: 'SCHEDULED' }],
    academicMemory: {
      profileDigest: 'طالب تشخيصي',
      lastConversationSummary: 'سأل الطالب عن الكتب والوحدات',
      examSignals: JSON.stringify(['نجح في اختبار الوحدة']),
      thesisSignals: JSON.stringify(['بحثه عن أثر مؤشرات المخاطر']),
      lastFileAnalysis: 'الملف البحثي يتضمن ملخصاً ومنهجية',
    },
  }
}

describe('ثوابت طالب التشخيص', () => {
  test('الهوية الثابتة مطابقة لقيم التجهيز', () => {
    expect(LAUNCH_QUALITY_EMAIL).toBe('launch.quality.student@aact.test')
    expect(LAUNCH_QUALITY_PROGRAM_SLUG).toBe('launch-quality-diagnostic-program')
    expect(LAUNCH_QUALITY_REFERENCE).toBe('AACT-LAUNCH-QUALITY')
    expect(LAUNCH_QUALITY_REQUEST_BUDGET_MS).toBe(70_000)
  })
})

describe('حارس اكتمال الطالب التشخيصي', () => {
  test('سجل مطابق لما تكتبه سلسلة التجهيز يُعد مكتملاً', () => {
    expect(diagnosticStudentIsComplete(completeStudent())).toBe(true)
  })

  test('غياب السجل أو اختلاف الهوية يرفض الاكتمال', () => {
    expect(diagnosticStudentIsComplete(null)).toBe(false)
    const wrongEmail = completeStudent(); wrongEmail.email = 'other@aact.test'
    expect(diagnosticStudentIsComplete(wrongEmail)).toBe(false)
    const wrongRole = completeStudent(); wrongRole.role = 'ADMIN'
    expect(diagnosticStudentIsComplete(wrongRole)).toBe(false)
    const wrongName = completeStudent(); wrongName.name = 'طالب آخر'
    expect(diagnosticStudentIsComplete(wrongName)).toBe(false)
  })

  test('تسجيل غير فعّال أو برنامج مختلف أو علاقات برنامج ناقصة ترفض الاكتمال', () => {
    const completedOnly = completeStudent(); completedOnly.enrollments[0].status = 'COMPLETED'
    expect(diagnosticStudentIsComplete(completedOnly)).toBe(false)
    const otherProgram = completeStudent(); otherProgram.enrollments[0].program.slug = 'another-program'
    expect(diagnosticStudentIsComplete(otherProgram)).toBe(false)
    const oneUnit = completeStudent(); oneUnit.enrollments[0].program.units = [{ title: 'وحدة واحدة' }]
    expect(diagnosticStudentIsComplete(oneUnit)).toBe(false)
    const noBooks = completeStudent(); noBooks.enrollments[0].program.books = []
    expect(diagnosticStudentIsComplete(noBooks)).toBe(false)
    const noGuides = completeStudent(); noGuides.enrollments[0].program.studyGuides = []
    expect(diagnosticStudentIsComplete(noGuides)).toBe(false)
  })

  test('مرجع قبول مختلف أو بحث بلا عنوان أو ذاكرة ناقصة ترفض الاكتمال', () => {
    const otherRef = completeStudent(); otherRef.ownedAdmissions = [{ reference: 'AACT-OTHER' }]
    expect(diagnosticStudentIsComplete(otherRef)).toBe(false)
    const noThesis = completeStudent(); noThesis.theses = [{ title: '', status: 'SCHEDULED' }]
    expect(diagnosticStudentIsComplete(noThesis)).toBe(false)
    const noMemory = completeStudent(); noMemory.academicMemory = null
    expect(diagnosticStudentIsComplete(noMemory)).toBe(false)
    const partialMemory = completeStudent(); partialMemory.academicMemory.lastFileAnalysis = ''
    expect(diagnosticStudentIsComplete(partialMemory)).toBe(false)
  })
})

describe('ميزانية الطلب الموحدة وأخطاء المهلة المسمّاة', () => {
  test('اسم خطأ الاستنفاد يحدد المرحلة ويُطهَّر من الرموز', () => {
    expect(launchQualityDeadlineError('PROBE_PROFILE')).toBe('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_PROBE_PROFILE')
    expect(launchQualityDeadlineError('probe:PROFILE')).toBe('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_PROBE_PROFILE')
    expect(launchQualityDeadlineError('DIAGNOSTIC_STUDENT')).toBe('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_DIAGNOSTIC_STUDENT')
  })

  test('التعرف على خطأ الاستنفاد لا يلتبس بالأخطاء العامة', () => {
    expect(isLaunchQualityDeadlineError(new Error('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_CONTEXT'))).toBe(true)
    expect(isLaunchQualityDeadlineError(new Error('database connection lost'))).toBe(false)
    expect(isLaunchQualityDeadlineError(null)).toBe(false)
  })

  test('المتبقي من الميزانية موجب قبل الأجل ويرمي خطأ مسمّى المرحلة بعده', () => {
    const remaining = remainingLaunchQualityBudget(performance.now() + 5_000, 'CONTEXT')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(5_000)
    expect(() => remainingLaunchQualityBudget(performance.now() - 1, 'CONTEXT')).toThrow('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_CONTEXT')
  })
})

describe('توصيلات المسار (دبابيس مصدرية)', () => {
  test('المسار يستورد الحارس والثوابت من وحدة lib القابلة للاختبار', () => {
    expect(routeSource).toContain("from '@/lib/launch-quality-diagnostic'")
    expect(routeSource).toContain('diagnosticStudentIsComplete')
  })

  test('القراءة أولاً: فحص الاكتمال يسبق استدعاء سلسلة التجهيز داخل findDiagnosticStudent', () => {
    const start = routeSource.indexOf('async function findDiagnosticStudent')
    const end = routeSource.indexOf('function buildContextCoverage')
    const segment = routeSource.slice(start, end > start ? end : start + 4000)
    const readIdx = segment.indexOf('diagnosticStudentIsComplete(existing)')
    const ensureIdx = segment.indexOf('ensureLaunchQualityDiagnosticStudent()')
    expect(readIdx).toBeGreaterThan(-1)
    expect(ensureIdx).toBeGreaterThan(-1)
    expect(readIdx).toBeLessThan(ensureIdx)
  })

  test('المجس يمرر deadlineMs فعلياً إلى وكيل المنصة وسقفه هو المتبقي من الميزانية', () => {
    const start = routeSource.indexOf('async function runAiProbe')
    const segment = routeSource.slice(start, start + 2500)
    expect(segment).toContain('deadlineMs,')
    expect(segment).toContain('Math.min(launchQualityAiTimeoutMs(), remaining)')
  })

  test('فشل المجس عند الاستنفاد صريح: passed وskipped كلاهما false في نتيجة الخطأ وفي مجس ما قبل التشغيل', () => {
    const failures = routeSource.match(/skipped: false/g) || []
    expect(failures.length).toBeGreaterThanOrEqual(2)
    expect(routeSource).toContain('deadlineFailedProbe(kind, student, stageFailure)')
  })

  test('استنفاد المراحل السابقة للمجسات يتحول إلى stageFailure بدل خطأ HTTP عام', () => {
    expect(routeSource).toContain('let stageFailure: string | null = null')
    expect(routeSource).toContain('if (!isLaunchQualityDeadlineError(error)) throw error')
    expect(routeSource).toContain("...(stageFailure ? { error: stageFailure } : {})")
  })

  test('فحص المزوّدين مخزّن 60 ثانية مع مشاركة الطلب الجاري', () => {
    expect(routeSource).toContain('PROVIDER_DIAGNOSTICS_TTL_MS = 60_000')
    expect(routeSource).toContain('providerDiagnosticsInFlight')
    expect(routeSource).toContain('cachedProviderDiagnostics()')
  })

  test('سقف الخادم 75 ثانية فوق الميزانية، ومهلة عميل الفحص تبقى 80 ثانية', () => {
    expect(routeSource).toContain('export const maxDuration = 75')
    expect(specSource).toContain('timeout: 80_000')
  })

  test('سجل المراحل يحمل الاسم والمدة وحالة النجاح فقط', () => {
    expect(routeSource).toContain('[launch-quality] stage=${stage} durationMs=${elapsed(start)} ok=${ok}')
  })
})
