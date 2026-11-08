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
