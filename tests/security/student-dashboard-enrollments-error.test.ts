// حارس انحدار (قرار صاحب المنصة 2026-11-10، بعد بوابة #721): فشل تحميل
// تسجيلات الطالب (/api/my/enrollments) كان يُبتلع بصمت في لوحة الطالب —
// الكود كان يستبدل الخطأ بقائمة فارغة، فتختفي تبويبات الطالب وبرامجه دون
// أي إشارة، ويُعامل كأنه غير مسجل. الإصلاح: علامة خطأ صريحة + حالة خطأ
// مرئية مع زر إعادة محاولة.
// هذه دبابيس مصدر مقترنة بفحص سلوكي للمسار نفسه في اختبارات البوابة
// (ux-guardrails / mobile-ux تعتمدان ظهور اسم البرنامج بعد التحميل).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const dashboardSource = readFileSync('src/components/aact/DashboardView.tsx', 'utf8')

describe('student dashboard enrollments load failure is surfaced, not swallowed', () => {
  test('the enrollments fetch records the failure instead of silently emptying the list', () => {
    expect(dashboardSource).toContain('enrollmentsFailed = true')
    expect(dashboardSource).toContain('setEnrollmentsLoadError(enrollmentsFailed)')
    // The old silent-swallow shape must not come back.
    expect(dashboardSource).not.toContain("api<{ enrollments: MyEnrollment[] }>('/api/my/enrollments').catch(() => ({ enrollments: [] as any[] }))")
  })

  test('a visible error state with a retry action is rendered when the load failed', () => {
    expect(dashboardSource).toContain('enrollmentsLoadError &&')
    expect(dashboardSource).toContain('تعذّر تحميل تسجيلاتك الدراسية')
    expect(dashboardSource).toContain('إعادة المحاولة')
  })
})
