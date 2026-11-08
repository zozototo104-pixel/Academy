import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== ربط واجهة قرار إنهاء الفصل (الخطوة 2) =====
// نافذة الخيارين عند «جاهز للامتحان» وزر الرفع المستقل والسحب —
// كلها مربوطة بمسار الطالب نفسه وبصمّام التفعيل الواحد، والوقائع
// المعروضة تأتي من موجز الخادم لا من حساب محلي.

const root = join(import.meta.dir, '..', '..')
const dashboard = readFileSync(join(root, 'src/components/aact/DashboardView.tsx'), 'utf8')
const decisionUi = readFileSync(join(root, 'src/components/aact/SemesterDecision.tsx'), 'utf8')
const progressRoute = readFileSync(join(root, 'src/app/api/progress/route.ts'), 'utf8')

describe('نافذة الخيارين ولوحة الحالة', () => {
  test('النافذة واللوحة مربوطتان في لوحة الطالب ومشروطتان بالتفعيل', () => {
    expect(dashboard).toContain('SemesterDecisionDialog')
    expect(dashboard).toContain('SemesterDecisionPanel')
    expect(dashboard).toContain('active.decisionActive')
    expect(dashboard).toContain("action: 'SEMESTER_DECISION'")
    expect(dashboard).toContain("action: 'SEMESTER_DECISION_WITHDRAW'")
  })
  test('ضغطة جاهز للامتحان تمر بالنافذة عند التفعيل وبالطريق القديم قبله', () => {
    expect(dashboard).toContain("setDecisionDialog({ semester, mode: 'ready' })")
    expect(dashboard).toContain('doMarkReadyForSemesterExam')
  })
  test('الخياران بالنص المتفق عليه وموافقة الصفر صريحة ومستقلة', () => {
    expect(decisionUi).toContain('أريد إنهاء الفصل مبكرًا')
    expect(decisionUi).toContain('أريد استكمال أعمال الفصل')
    expect(decisionUi).toContain('أوافق على احتساب الأعمال غير المقدَّمة صفرًا وإغلاق الفصل عند الاعتماد')
    expect(decisionUi).toContain('كيف تريد متابعة الفصل الدراسي؟')
    expect(decisionUi).toContain("onConfirm(choice, choice === 'EARLY_FINISH' && consent)")
    expect(dashboard).toContain('consentToZeros')
    expect(progressRoute).toContain('EARLY_CLOSE_CONSENT_REQUIRED')
  })
  test('حالات الطلب كلها معروضة للطالب بما فيها تغيّر الدرجات بعد الرفع', () => {
    expect(decisionUi).toContain('نتيجتك مرفوعة للإدارة بانتظار الاعتماد')
    expect(decisionUi).toContain('طلب الإنهاء المبكر محفوظ')
    expect(decisionUi).toContain('سحب طلب الرفع')
    expect(decisionUi).toContain('ارفع نتيجة فصلي للاعتماد')
    expect(decisionUi).toContain('درجاتك تغيّرت منذ الرفع')
    expect(decisionUi).toContain('انتهت فترة هذا الفصل')
  })
})

describe('مسار الطالب الخادمي', () => {
  test('الإجراءات موجودة ومحروسة بالصمّام والنضج مشتق خادميًا', () => {
    expect(progressRoute).toContain("action === 'SEMESTER_DECISION'")
    expect(progressRoute).toContain('SEMESTER_DECISION_INACTIVE')
    expect(progressRoute).toContain('requestSemesterDecision')
    expect(progressRoute).toContain('withdrawSemesterRaise')
    expect(progressRoute).toContain('getSemesterDecisionBrief')
    expect(progressRoute).toContain('decisionActive: SEMESTER_DECISION_ACTIVE')
  })
})

const adminExtras = readFileSync(join(root, 'src/components/aact/AdminExtras.tsx'), 'utf8')
const approvalLib = readFileSync(join(root, 'src/lib/semester-approval.ts'), 'utf8')
const decisionLib = readFileSync(join(root, 'src/lib/semester-decision.ts'), 'utf8')

describe('تطابق زر الإدارة مع الخادم (الخطوة 3)', () => {
  test('بطاقة التخرج تقرأ ملخص القرار وتعطّل الزر على نفس حق الإغلاق', () => {
    expect(adminExtras).toContain('decisionSummary')
    expect(adminExtras).toContain('chk.decisionSummary.closure.allowed')
    expect(adminExtras).toContain('قرار الطالب وحق الإغلاق')
    expect(adminExtras).toContain('بانتظار قرار الطالب')
    expect(adminExtras).toContain('درجات الطالب تغيّرت منذ الرفع')
  })
  test('الحارس الخادمي فيه النهائية السياقية وبوابة الإغلاق الأخيرة', () => {
    expect(approvalLib).toContain('evaluateContextualFinality')
    expect(approvalLib).toContain("code: 'SEMESTER_NOT_RAISED'")
    expect(approvalLib).toContain('CONTEXTUAL FINALITY')
  })
  test('الصمّام مفعّل بعد اكتمال الخطوات 1-3', () => {
    expect(decisionLib).toContain('SEMESTER_DECISION_ACTIVE = true')
  })
})
