import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== تنظيم مراجعة التصحيح حسب الطالب + المصادقة الجماعية (الخطوة 4) =====
// طلب المالك: لا صيد محاولة-محاولة بلا معرفة مَن صُدّق — القائمة
// مجمّعة حسب الطالب، وحالة المصادقة ظاهرة على كل درجة، والمصادقة
// الجماعية تمر ببوابة المصادقة المفردة نفسها لكل عنصر.

const root = join(import.meta.dir, '..', '..')
const tab = readFileSync(join(root, 'src/components/aact/AdminGradingReviewTab.tsx'), 'utf8')
const listRoute = readFileSync(join(root, 'src/app/api/admin/attempts-review/route.ts'), 'utf8')
const adminApprovals = readFileSync(join(root, 'src/app/api/admin/grade-approvals/route.ts'), 'utf8')
const supervisorApprovals = readFileSync(join(root, 'src/app/api/supervisor/grade-approvals/route.ts'), 'utf8')
const approvalLib = readFileSync(join(root, 'src/lib/grade-approval.ts'), 'utf8')
const certificatesUi = readFileSync(join(root, 'src/components/aact/AdminExtras.tsx'), 'utf8')
const studentsApi = readFileSync(join(root, 'src/app/api/admin/students/route.ts'), 'utf8')
const mercyUi = readFileSync(join(root, 'src/components/aact/AdminMercy.tsx'), 'utf8')
const reopenUi = readFileSync(join(root, 'src/components/aact/AdminReopenAppeals.tsx'), 'utf8')
const adminPreviewApi = readFileSync(join(root, 'src/app/api/admin/students/preview/route.ts'), 'utf8')
const adminPreviewUi = readFileSync(join(root, 'src/components/aact/AdminStudentPreview.tsx'), 'utf8')
const supervisorStudentsApi = readFileSync(join(root, 'src/app/api/supervisor/students/route.ts'), 'utf8')
const supervisorUi = readFileSync(join(root, 'src/components/aact/SupervisorView.tsx'), 'utf8')

describe('التجميع حسب الطالب وحالات المصادقة', () => {
  test('القائمة مجمعة حسب الطالب لا مسطّحة', () => {
    expect(tab).toContain('مراجعة التصحيح — حسب الطالب')
    expect(tab).toContain('byStudent')
    expect(tab).toContain('toggleStudent')
  })
  test('حالات المصادقة الثلاث ظاهرة على كل درجة', () => {
    expect(tab).toContain('مصادقة رسميًا')
    expect(tab).toContain('مصادقة قديمة — الدرجة تغيّرت')
    expect(tab).toContain('غير مصادقة')
    expect(listRoute).toContain('approvalState')
    expect(listRoute).toContain("? 'APPROVED' : 'STALE'")
  })
  test('حالة المصادقة تأتي من الخادم بنفس قاعدة المساواة', () => {
    expect(listRoute).toContain('db.gradeApproval.findMany')
    expect(listRoute).toContain('approvedScore.get(key) === r.score')
  })
})

describe('منع التكرار والمصادقة الجماعية', () => {
  test('المصادقة المفردة تقصر عند نفس القيمة بلا إعادة كتابة ولا تدقيق مكرر', () => {
    expect(approvalLib).toContain('alreadyApproved: true')
    expect(approvalLib).toContain('existing.score === resolved.score')
  })
  test('الجماعية تعيد استخدام البوابة المفردة وترجع تقريرًا لكل عنصر', () => {
    expect(approvalLib).toContain('approveGradesBulk')
    expect(approvalLib).toContain('const decision = await approveGrade({')
    expect(adminApprovals).toContain('approveGradesBulk')
    expect(supervisorApprovals).toContain('approveGradesBulk')
  })
  test('فشل قاعدة البيانات لا ينتحل هوية انتهاء جلسة ولا يُخفي نتائج بقية الدرجات', () => {
    expect(approvalLib).toContain('::text AS acquired')
    expect(approvalLib).toContain("code: 'INTERNAL_ERROR'")
    expect(adminApprovals).toContain("code: 'GRADE_APPROVAL_INTERNAL_ERROR'")
    expect(adminApprovals).toContain('status: 500')
    expect(tab).toContain("item.code === 'INTERNAL_ERROR'")
  })
  test('أزرار الجماعية على الواجهة بخطوة تأكيد وتقرير بعدي', () => {
    expect(tab).toContain('مصادقة كل الدرجات النهائية غير المصادقة')
    expect(tab).toContain('مصادقة الكل')
    expect(tab).toContain('نتيجة المصادقة الجماعية')
    expect(tab).toContain('armBulk')
  })
})

describe('تنظيم معاملات الشهادات والالتماسات على الجوال', () => {
  test('قائمتان أساسيتان للمكتمل وقيد الاستكمال وتفاصيل بالضغط على الاسم', () => {
    expect(certificatesUi).toContain("certificatePhase === 'IN_PROGRESS'")
    expect(certificatesUi).toContain("certificatePhase === 'COMPLETED'")
    expect(certificatesUi).toContain('expandedGraduationRequestId === r.id')
    expect(certificatesUi).toContain('expandedCertificateId === c.serial')
    expect(certificatesUi).toContain('expandedCandidateId === c.id')
  })
  test('البحث في الطلاب يدعم الاسم الرسمي وفصل العرض عن اسم الحساب', () => {
    expect(studentsApi).toContain("nameWords.map((word)")
    expect(studentsApi).toContain('officialName: latestAdmission?.fullName')
  })
  test('قوائم الالتماسات لا تختفي عند الصفر ولا تخفي خطأ القراءة', () => {
    expect(mercyUi).toContain('لا توجد طلبات استرحام حاليًا')
    expect(reopenUi).toContain('لا توجد التماسات إعادة فتح قيد البتّ حاليًا')
    expect(mercyUi).toContain('role="alert"')
    expect(reopenUi).toContain('role="alert"')
  })
})
