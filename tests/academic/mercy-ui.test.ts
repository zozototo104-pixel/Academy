// باب الاسترحام (قرار المالك 2026-11-08): نظام الاسترحام كان
// خادميًا فقط — لا طالب يطلبه ولا إدارة تُسند/تصحّح من أي شاشة.
// هذه الدبابيس تثبّت الباب: لوحة الطالب (طلب + تسليم عبر المسارات
// القائمة)، وقائمة الإدارة (إسناد + تصحيح) مركّبة بتبويب مراجعة
// الدرجات، وإثراء قائمة الإدارة بالأسماء، وتغطية بوابة الانتقال.
// التشغيل: bun test tests/academic/mercy-ui.test.ts (منفردًا)
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('باب الاسترحام — واجهات', () => {
  test('لوحة الطالب تطلب وتسلّم عبر المسارات القائمة وتُركَّب بالوحة الطالب', () => {
    const panel = read('src/components/aact/Mercy.tsx')
    expect(panel).toContain('StudentMercyPanel')
    expect(panel).toContain("api<{ requests: MercyRow[]; eligible: Eligible[] }>('/api/mercy')")
    expect(panel).toContain("'/api/mercy/submit'")
    expect(panel).toContain('طلب استرحام')
    expect(panel).toContain('ACTIVITY_ASSIGNED')
    const dash = read('src/components/aact/DashboardView.tsx')
    expect(dash).toContain("import { StudentMercyPanel } from '@/components/aact/Mercy'")
    expect(dash).toContain('<StudentMercyPanel />')
  })

  test('قائمة الإدارة تُسند وتصحّح ومركّبة بتبويب مراجعة الدرجات', () => {
    const queue = read('src/components/aact/AdminMercy.tsx')
    expect(queue).toContain('AdminMercyQueue')
    expect(queue).toContain("'/api/admin/mercy'")
    expect(queue).toContain("action: 'assign'")
    expect(queue).toContain("action: 'grade'")
    expect(queue).toContain('أعد اعتماد نتيجة الفصل')
    const view = read('src/components/aact/AdminView.tsx')
    expect(view).toContain('<AdminMercyQueue />')
  })

  test('قائمة الإدارة مثراة بأسماء الطلاب والبرامج', () => {
    const route = read('src/app/api/admin/mercy/route.ts')
    expect(route).toContain('studentName')
    expect(route).toContain('programTitle')
  })

  test('لا الاسترحام ولا البحث يعوّضان الجلوس الفعلي لامتحان الفصل', () => {
    const progression = read('src/lib/progression.ts')
    expect(progression).toContain('semesterExamsSat(client, enrollment.userId, enrollment.programId, s)')
    expect(progression).toContain('semesterExamsSat(client, enrollment.userId, enrollment.programId, semestersCount)')
    expect(progression).not.toContain('semesterExamCoveredByMercy')
    const mercy = read('src/lib/mercy.ts')
    expect(mercy).toContain("code: 'SEMESTER_EXAM_NOT_TAKEN'")
    const studentApi = read('src/app/api/mercy/route.ts')
    expect(studentApi).toContain('await semesterExamsSat(db, user.id, enr.programId, s.semester)')
    const panel = read('src/components/aact/Mercy.tsx')
    expect(panel).toContain('الاسترحام لا يحل محل الامتحان')
  })
})
